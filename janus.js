// List of sessions
Janus.sessions = {};

Janus.isExtensionEnabled = function() {
	if(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
		// No need for the extension, getDisplayMedia is supported
		return true;
	}
	if(window.navigator.userAgent.match('Chrome')) {
		var chromever = parseInt(window.navigator.userAgent.match(/Chrome\/(.*) /)[1], 10);
		var maxver = 33;
		if(window.navigator.userAgent.match('Linux'))
			maxver = 35;	// "known" crash in chrome 34 and 35 on linux
		if(chromever >= 26 && chromever <= maxver) {
			// Older versions of Chrome don't support this extension-based approach, so lie
			return true;
		}
		return Janus.extension.isInstalled();
	} else {
		// Firefox of others, no need for the extension (but this doesn't mean it will work)
		return true;
	}
};

var defaultExtension = {
	// Screensharing Chrome Extension ID
	extensionId: 'hapfgfdkleiggjjpfpenajgdnfckjpaj',
	isInstalled: function() { return document.querySelector('#janus-extension-installed') !== null; },
	getScreen: function (callback) {
		var pending = window.setTimeout(function () {
			var error = new Error('NavigatorUserMediaError');
			error.name = 'The required Chrome extension is not installed: click <a href="#">here</a> to install it. (NOTE: this will need you to refresh the page)';
			return callback(error);
		}, 1000);
		this.cache[pending] = callback;
		window.postMessage({ type: 'janusGetScreen', id: pending }, '*');
	},
	init: function () {
		var cache = {};
		this.cache = cache;
		// Wait for events from the Chrome Extension
		window.addEventListener('message', function (event) {
			if(event.origin != window.location.origin)
				return;
			if(event.data.type == 'janusGotScreen' && cache[event.data.id]) {
				var callback = cache[event.data.id];
				delete cache[event.data.id];

				if (event.data.sourceId === '') {
					// user canceled
					var error = new Error('NavigatorUserMediaError');
					error.name = 'You cancelled the request for permission, giving up...';
					callback(error);
				} else {
					callback(null, event.data.sourceId);
				}
			} else if (event.data.type == 'janusGetScreenPending') {
				console.log('clearing ', event.data.id);
				window.clearTimeout(event.data.id);
			}
		});
	}
};

Janus.useDefaultDependencies = function (deps) {
	var f = (deps && deps.fetch) || fetch;
	var p = (deps && deps.Promise) || Promise;
	var socketCls = (deps && deps.WebSocket) || WebSocket;

	return {
		newWebSocket: function(server, proto) { return new socketCls(server, proto); },
		extension: (deps && deps.extension) || defaultExtension,
		isArray: function(arr) { return Array.isArray(arr); },
		webRTCAdapter: (deps && deps.adapter) || adapter,
		httpAPICall: function(url, options) {
			var fetchOptions = {
				method: options.verb,
				headers: {
					'Accept': 'application/json, text/plain, */*'
				},
				cache: 'no-cache'
			};
			if(options.verb === "POST") {
				fetchOptions.headers['Content-Type'] = 'application/json';
			}
			if(options.withCredentials !== undefined) {
				fetchOptions.credentials = options.withCredentials === true ? 'include' : (options.withCredentials ? options.withCredentials : 'omit');
			}
			if(options.body) {
				fetchOptions.body = JSON.stringify(options.body);
			}

			var fetching = f(url, fetchOptions).catch(function(error) {
				return p.reject({message: 'Probably a network error, is the server down?', error: error});
			});

			/*
			 * fetch() does not natively support timeouts.
			 * Work around this by starting a timeout manually, and racing it agains the fetch() to see which thing resolves first.
			 */

			if(options.timeout) {
				var timeout = new p(function(resolve, reject) {
					var timerId = setTimeout(function() {
						clearTimeout(timerId);
						return reject({message: 'Request timed out', timeout: options.timeout});
					}, options.timeout);
				});
				fetching = p.race([fetching, timeout]);
			}

			fetching.then(function(response) {
				if(response.ok) {
					if(typeof(options.success) === typeof(Janus.noop)) {
						return response.json().then(function(parsed) {
							options.success(parsed);
						}).catch(function(error) {
							return p.reject({message: 'Failed to parse response body', error: error, response: response});
						});
					}
				}
				else {
					return p.reject({message: 'API call failed', response: response});
				}
			}).catch(function(error) {
				if(typeof(options.error) === typeof(Janus.noop)) {
					options.error(error.message || '<< internal error >>', error);
				}
			});

			return fetching;
		}
	}
};

Janus.useOldDependencies = function (deps) {
	var jq = (deps && deps.jQuery) || jQuery;
	var socketCls = (deps && deps.WebSocket) || WebSocket;
	return {
		newWebSocket: function(server, proto) { return new socketCls(server, proto); },
		isArray: function(arr) { return jq.isArray(arr); },
		extension: (deps && deps.extension) || defaultExtension,
		webRTCAdapter: (deps && deps.adapter) || adapter,
		httpAPICall: function(url, options) {
			var payload = options.body !== undefined ? {
				contentType: 'application/json',
				data: JSON.stringify(options.body)
			} : {};
			var credentials = options.withCredentials !== undefined ? {xhrFields: {withCredentials: options.withCredentials}} : {};

			return jq.ajax(jq.extend(payload, credentials, {
				url: url,
				type: options.verb,
				cache: false,
				dataType: 'json',
				async: options.async,
				timeout: options.timeout,
				success: function(result) {
					if(typeof(options.success) === typeof(Janus.noop)) {
						options.success(result);
					}
				},
				error: function(xhr, status, err) {
					if(typeof(options.error) === typeof(Janus.noop)) {
						options.error(status, err);
					}
				}
			}));
		}
	};
};

Janus.noop = function() {};

Janus.dataChanDefaultLabel = "JanusDataChannel";

// Note: in the future we may want to change this, e.g., as was
// attempted in https://github.com/meetecho/janus-gateway/issues/1670
Janus.endOfCandidates = null;

// Stop all tracks from a given stream
Janus.stopAllTracks = function(stream) {
	try {
		// Try a MediaStreamTrack.stop() for each track
		var tracks = stream.getTracks();
		for(var mst of tracks) {
			Janus.log(mst);
			if(mst) {
				mst.stop();
			}
		}
	} catch(e) {
		// Do nothing if this fails
	}
}

// Initialization
Janus.init = function(options) {
	options = options || {};
	options.callback = (typeof options.callback == "function") ? options.callback : Janus.noop;
	if(Janus.initDone) {
		// Already initialized
		options.callback();
	} else {
		if(typeof console == "undefined" || typeof console.log == "undefined") {
			console = { log: function() {} };
		}
		// Console logging (all debugging disabled by default)
		Janus.trace = Janus.noop;
		Janus.debug = Janus.noop;
		Janus.vdebug = Janus.noop;
		Janus.log = Janus.noop;
		Janus.warn = Janus.noop;
		Janus.error = Janus.noop;
		if(options.debug === true || options.debug === "all") {
			// Enable all debugging levels
			Janus.trace = console.trace.bind(console);
			Janus.debug = console.debug.bind(console);
			Janus.vdebug = console.debug.bind(console);
			Janus.log = console.log.bind(console);
			Janus.warn = console.warn.bind(console);
			Janus.error = console.error.bind(console);
		} else if(Array.isArray(options.debug)) {
			for(var d of options.debug) {
				switch(d) {
					case "trace":
						Janus.trace = console.trace.bind(console);
						break;
					case "debug":
						Janus.debug = console.debug.bind(console);
						break;
					case "vdebug":
						Janus.vdebug = console.debug.bind(console);
						break;
					case "log":
						Janus.log = console.log.bind(console);
						break;
					case "warn":
						Janus.warn = console.warn.bind(console);
						break;
					case "error":
						Janus.error = console.error.bind(console);
						break;
					default:
						console.error("Unknown debugging option '" + d + "' (supported: 'trace', 'debug', 'vdebug', 'log', warn', 'error')");
						break;
				}
			}
		}
		Janus.log("Initializing library");

		var usedDependencies = options.dependencies || Janus.useDefaultDependencies();
		Janus.isArray = usedDependencies.isArray;
		Janus.webRTCAdapter = usedDependencies.webRTCAdapter;
		Janus.httpAPICall = usedDependencies.httpAPICall;
		Janus.newWebSocket = usedDependencies.newWebSocket;
		Janus.extension = usedDependencies.extension;
		Janus.extension.init();

		// Helper method to enumerate devices
		Janus.listDevices = function(callback, config) {
			callback = (typeof callback == "function") ? callback : Janus.noop;
			if (config == null) config = { audio: true, video: true };
			if(Janus.isGetUserMediaAvailable()) {
				navigator.mediaDevices.getUserMedia(config)
				.then(function(stream) {
					navigator.mediaDevices.enumerateDevices().then(function(devices) {
						Janus.debug(devices);
						callback(devices, stream);
						// Get rid of the now useless stream
						Janus.stopAllTracks(stream)
					});
				})
				.catch(function(err) {
					Janus.error(err);
					callback([]);
				});
			} else {
				Janus.warn("navigator.mediaDevices unavailable");
				callback([]);
			}
		};
		// Helper methods to attach/reattach a stream to a video element (previously part of adapter.js)
		Janus.attachMediaStream = function(element, stream) {
			try {
				element.srcObject = stream;
			} catch (e) {
				try {
					element.src = URL.createObjectURL(stream);
				} catch (e) {
					Janus.error("Error attaching stream to element");
				}
				element.onloadedmetadata = function(e) {
					element.play();
					Janus.log("play localstream start....")
				}
			}
		};
		Janus.reattachMediaStream = function(to, from) {
			try {
				to.srcObject = from.srcObject;
			} catch (e) {
				try {
					to.src = from.src;
				} catch (e) {
					Janus.error("Error reattaching stream to element");
				}
			}
		};
	
		
		// Detect tab close: make sure we don't loose existing onbeforeunload handlers
		// (note: for iOS we need to subscribe to a different event, 'pagehide', see
		// https://gist.github.com/thehunmonkgroup/6bee8941a49b86be31a787fe8f4b8cfe)
		var iOS = ['iPad', 'iPhone', 'iPod'].indexOf(navigator.platform) >= 0;
		var eventName = iOS ? 'pagehide' : 'beforeunload';
		var oldOBF = window["on" + eventName];
		window.addEventListener(eventName, function(event) {
			Janus.log("Closing window");
			for(var s in Janus.sessions) {
				if(Janus.sessions[s] && Janus.sessions[s].destroyOnUnload) {
					Janus.log("Destroying session " + s);
					Janus.sessions[s].destroy({unload: true, notifyDestroyed: false});
				}
			}
			if(oldOBF && typeof oldOBF == "function") {
				oldOBF();
			}
		});
		// If this is a Safari Technology Preview, check if VP8 is supported
		Janus.safariVp8 = false;
		if(Janus.webRTCAdapter.browserDetails.browser === 'safari' &&
				Janus.webRTCAdapter.browserDetails.version >= 605) {
			// Let's see if RTCRtpSender.getCapabilities() is there
			if(RTCRtpSender && RTCRtpSender.getCapabilities && RTCRtpSender.getCapabilities("video") &&
					RTCRtpSender.getCapabilities("video").codecs && RTCRtpSender.getCapabilities("video").codecs.length) {
				for(var codec of RTCRtpSender.getCapabilities("video").codecs) {
					if(codec && codec.mimeType && codec.mimeType.toLowerCase() === "video/vp8") {
						Janus.safariVp8 = true;
						break;
					}
				}
				if(Janus.safariVp8) {
					Janus.log("This version of Safari supports VP8");
				} else {
					Janus.warn("This version of Safari does NOT support VP8: if you're using a Technology Preview, " +
						"try enabling the 'WebRTC VP8 codec' setting in the 'Experimental Features' Develop menu");
				}
			} else {
				// We do it in a very ugly way, as there's no alternative...
				// We create a PeerConnection to see if VP8 is in an offer
				var testpc = new RTCPeerConnection({});
				testpc.createOffer({offerToReceiveVideo: true}).then(function(offer) {
					Janus.safariVp8 = offer.sdp.indexOf("VP8") !== -1;
					if(Janus.safariVp8) {
						Janus.log("This version of Safari supports VP8");
					} else {
						Janus.warn("This version of Safari does NOT support VP8: if you're using a Technology Preview, " +
							"try enabling the 'WebRTC VP8 codec' setting in the 'Experimental Features' Develop menu");
					}
					testpc.close();
					testpc = null;
				});
			}
		}
		// Check if this browser supports Unified Plan and transceivers
		// Based on https://codepen.io/anon/pen/ZqLwWV?editors=0010
		Janus.unifiedPlan = false;
		if(Janus.webRTCAdapter.browserDetails.browser === 'firefox' &&
				Janus.webRTCAdapter.browserDetails.version >= 59) {
			// Firefox definitely does, starting from version 59
			Janus.unifiedPlan = true;
		} else if(Janus.webRTCAdapter.browserDetails.browser === 'chrome' &&
				Janus.webRTCAdapter.browserDetails.version < 72) {
			// Chrome does, but it's only usable from version 72 on
			Janus.unifiedPlan = false;
		} else if(!window.RTCRtpTransceiver || !('currentDirection' in RTCRtpTransceiver.prototype)) {
			// Safari supports addTransceiver() but not Unified Plan when
			// currentDirection is not defined (see codepen above).
			Janus.unifiedPlan = false;
		} else {
			// Check if addTransceiver() throws an exception
			var tempPc = new RTCPeerConnection();
			try {
				tempPc.addTransceiver('audio');
				Janus.unifiedPlan = true;
			} catch (e) {}
			tempPc.close();
		}
		Janus.initDone = true;
		options.callback();
	}
};

// Helper method to check whether WebRTC is supported by this browser
Janus.isWebrtcSupported = function() {
	return !!window.RTCPeerConnection;
};
// Helper method to check whether devices can be accessed by this browser (e.g., not possible via plain HTTP)
Janus.isGetUserMediaAvailable = function() {
	return navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
};

// Helper method to create random identifiers (e.g., transaction)
Janus.randomString = function(len) {
	var charSet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	var randomString = '';
	for (var i = 0; i < len; i++) {
		var randomPoz = Math.floor(Math.random() * charSet.length);
		randomString += charSet.substring(randomPoz,randomPoz+1);
	}
	return randomString;
};



Janus.prepareLocalStream = function(offer, callbacks) {
	callbacks = callbacks || {};
	callbacks.success = (typeof callbacks.success == "function") ? callbacks.success : Janus.noop;
	callbacks.error = (typeof callbacks.error == "function") ? callbacks.error : webrtcError;
	var jsep = callbacks.jsep;
	if(offer && jsep) {
		Janus.error("Provided a JSEP to a createOffer");
		callbacks.error("Provided a JSEP to a createOffer");
		return;
	} else if(!offer && (!jsep || !jsep.type || !jsep.sdp)) {
		Janus.error("A valid JSEP is required for createAnswer");
		callbacks.error("A valid JSEP is required for createAnswer");
		return;
	}
	/* Check that callbacks.media is a (not null) Object */
	callbacks.media = (typeof callbacks.media === 'object' && callbacks.media) ? callbacks.media : { audio: true, video: true };
	var media = callbacks.media;

	// Nope, new PeerConnection
	media.update = false;
	media.keepAudio = false;
	media.keepVideo = false;

	// If we're updating, check if we need to remove/replace one of the tracks
	if(media.update && !config.streamExternal) {
		if(media.removeAudio || media.replaceAudio) {
			if(config.myStream && config.myStream.getAudioTracks() && config.myStream.getAudioTracks().length) {
				var at = config.myStream.getAudioTracks()[0];
				Janus.log("Removing audio track:", at);
				config.myStream.removeTrack(at);
				try {
					at.stop();
				} catch(e) {}
			}
			if(config.pc.getSenders() && config.pc.getSenders().length) {
				var ra = true;
				if(media.replaceAudio && Janus.unifiedPlan) {
					// We can use replaceTrack
					ra = false;
				}
				if(ra) {
					for(var asnd of config.pc.getSenders()) {
						if(asnd && asnd.track && asnd.track.kind === "audio") {
							Janus.log("Removing audio sender:", asnd);
							config.pc.removeTrack(asnd);
						}
					}
				}
			}
		}
		if(media.removeVideo || media.replaceVideo) {
			if(config.myStream && config.myStream.getVideoTracks() && config.myStream.getVideoTracks().length) {
				var vt = config.myStream.getVideoTracks()[0];
				Janus.log("Removing video track:", vt);
				config.myStream.removeTrack(vt);
				try {
					vt.stop();
				} catch(e) {}
			}
			if(config.pc.getSenders() && config.pc.getSenders().length) {
				var rv = true;
				if(media.replaceVideo && Janus.unifiedPlan) {
					// We can use replaceTrack
					rv = false;
				}
				if(rv) {
					for(var vsnd of config.pc.getSenders()) {
						if(vsnd && vsnd.track && vsnd.track.kind === "video") {
							Janus.log("Removing video sender:", vsnd);
							config.pc.removeTrack(vsnd);
						}
					}
				}
			}
		}
	}
	// Was a MediaStream object passed, or do we need to take care of that?
	if(callbacks.stream) {
		var stream = callbacks.stream;
		Janus.log("MediaStream provided by the application");
		Janus.debug(stream);
		// If this is an update, let's check if we need to release the previous stream
		if(media.update) {
			if(config.myStream && config.myStream !== callbacks.stream && !config.streamExternal) {
				// We're replacing a stream we captured ourselves with an external one
				Janus.stopAllTracks(config.myStream);
				config.myStream = null;
			}
		}
		// Skip the getUserMedia part
		config.streamExternal = true;
		//pluginHandle.consentDialog(false);
		streamsDone(handleId, jsep, media, callbacks, stream);
		return;
	}
	if(isAudioSendEnabled(media) || isVideoSendEnabled(media)) {
		if(!Janus.isGetUserMediaAvailable()) {
			callbacks.error("getUserMedia not available");
			return;
		}
		var constraints = { mandatory: {}, optional: []};
		//pluginHandle.consentDialog(true);
		var audioSupport = isAudioSendEnabled(media);
		if(audioSupport && media && typeof media.audio === 'object')
			audioSupport = media.audio;
		var videoSupport = isVideoSendEnabled(media);
		if(videoSupport && media) {
			var simulcast = (callbacks.simulcast === true);
			var simulcast2 = (callbacks.simulcast2 === true);
			if((simulcast || simulcast2) && !jsep && !media.video)
				media.video = "hires";
			if(media.video && media.video != 'screen' && media.video != 'window') {
				if(typeof media.video === 'object') {
					videoSupport = media.video;
				} else {
					var width = 0;
					var height = 0, maxHeight = 0;
					if(media.video === 'lowres') {
						// Small resolution, 4:3
						height = 240;
						maxHeight = 240;
						width = 320;
					} else if(media.video === 'lowres-16:9') {
						// Small resolution, 16:9
						height = 180;
						maxHeight = 180;
						width = 320;
					} else if(media.video === 'hires' || media.video === 'hires-16:9' || media.video === 'hdres') {
						// High(HD) resolution is only 16:9
						height = 720;
						maxHeight = 720;
						width = 1280;
					} else if(media.video === 'fhdres') {
						// Full HD resolution is only 16:9
						height = 1080;
						maxHeight = 1080;
						width = 1920;
					} else if(media.video === '4kres') {
						// 4K resolution is only 16:9
						height = 2160;
						maxHeight = 2160;
						width = 3840;
					} else if(media.video === 'stdres') {
						// Normal resolution, 4:3
						height = 480;
						maxHeight = 480;
						width = 640;
					} else if(media.video === 'stdres-16:9') {
						// Normal resolution, 16:9
						height = 360;
						maxHeight = 360;
						width = 640;
					} else {
						Janus.log("Default video setting is stdres 4:3");
						height = 480;
						maxHeight = 480;
						width = 640;
					}
					Janus.log("Adding media constraint:", media.video);
					videoSupport = {
						'height': {'ideal': height},
						'width': {'ideal': width}
					};
					Janus.log("Adding video constraint:", videoSupport);
				}
			} else if(media.video === 'screen' || media.video === 'window') {
				if(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
					// The new experimental getDisplayMedia API is available, let's use that
					// https://groups.google.com/forum/#!topic/discuss-webrtc/Uf0SrR4uxzk
					// https://webrtchacks.com/chrome-screensharing-getdisplaymedia/
					constraints.video = {};
					if(media.screenshareFrameRate) {
						constraints.video.frameRate = media.screenshareFrameRate;
					}
					if(media.screenshareHeight) {
						constraints.video.height = media.screenshareHeight;
					}
					if(media.screenshareWidth) {
						constraints.video.width = media.screenshareWidth;
					}
					constraints.audio = media.captureDesktopAudio;
					navigator.mediaDevices.getDisplayMedia(constraints)
						.then(function(stream) {
							//pluginHandle.consentDialog(false);
							if(isAudioSendEnabled(media) && !media.keepAudio) {
								navigator.mediaDevices.getUserMedia({ audio: true, video: false })
								.then(function (audioStream) {
									stream.addTrack(audioStream.getAudioTracks()[0]);
									streamsDone(handleId, jsep, media, callbacks, stream);
								})
							} else {
								streamsDone(handleId, jsep, media, callbacks, stream);
							}
						}, function (error) {
							//pluginHandle.consentDialog(false);
							callbacks.error(error);
						});
					return;
				}
				// We're going to try and use the extension for Chrome 34+, the old approach
				// for older versions of Chrome, or the experimental support in Firefox 33+
				function callbackUserMedia (error, stream) {
					//pluginHandle.consentDialog(false);
					if(error) {
						callbacks.error(error);
					} else {
						streamsDone(handleId, jsep, media, callbacks, stream);
					}
				}
				function getScreenMedia(constraints, gsmCallback, useAudio) {
					Janus.log("Adding media constraint (screen capture)");
					Janus.debug(constraints);
					navigator.mediaDevices.getUserMedia(constraints)
						.then(function(stream) {
							if(useAudio) {
								navigator.mediaDevices.getUserMedia({ audio: true, video: false })
								.then(function (audioStream) {
									stream.addTrack(audioStream.getAudioTracks()[0]);
									gsmCallback(null, stream);
								})
							} else {
								gsmCallback(null, stream);
							}
						})
						.catch(function(error) { 
						     //pluginHandle.consentDialog(false); 
							 gsmCallback(error); 
						});
				}
				if(Janus.webRTCAdapter.browserDetails.browser === 'chrome') {
					var chromever = Janus.webRTCAdapter.browserDetails.version;
					var maxver = 33;
					if(window.navigator.userAgent.match('Linux'))
						maxver = 35;	// "known" crash in chrome 34 and 35 on linux
					if(chromever >= 26 && chromever <= maxver) {
						// Chrome 26->33 requires some awkward chrome://flags manipulation
						constraints = {
							video: {
								mandatory: {
									googLeakyBucket: true,
									maxWidth: window.screen.width,
									maxHeight: window.screen.height,
									minFrameRate: media.screenshareFrameRate,
									maxFrameRate: media.screenshareFrameRate,
									chromeMediaSource: 'screen'
								}
							},
							audio: isAudioSendEnabled(media) && !media.keepAudio
						};
						getScreenMedia(constraints, callbackUserMedia);
					} else {
						// Chrome 34+ requires an extension
						Janus.extension.getScreen(function (error, sourceId) {
							if (error) {
								//pluginHandle.consentDialog(false);
								return callbacks.error(error);
							}
							constraints = {
								audio: false,
								video: {
									mandatory: {
										chromeMediaSource: 'desktop',
										maxWidth: window.screen.width,
										maxHeight: window.screen.height,
										minFrameRate: media.screenshareFrameRate,
										maxFrameRate: media.screenshareFrameRate,
									},
									optional: [
										{googLeakyBucket: true},
										{googTemporalLayeredScreencast: true}
									]
								}
							};
							constraints.video.mandatory.chromeMediaSourceId = sourceId;
							getScreenMedia(constraints, callbackUserMedia,
								isAudioSendEnabled(media) && !media.keepAudio);
						});
					}
				} else if(Janus.webRTCAdapter.browserDetails.browser === 'firefox') {
					if(Janus.webRTCAdapter.browserDetails.version >= 33) {
						// Firefox 33+ has experimental support for screen sharing
						constraints = {
							video: {
								mozMediaSource: media.video,
								mediaSource: media.video
							},
							audio: isAudioSendEnabled(media) && !media.keepAudio
						};
						getScreenMedia(constraints, function (err, stream) {
							callbackUserMedia(err, stream);
							// Workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=1045810
							if (!err) {
								var lastTime = stream.currentTime;
								var polly = window.setInterval(function () {
									if(!stream)
										window.clearInterval(polly);
									if(stream.currentTime == lastTime) {
										window.clearInterval(polly);
										if(stream.onended) {
											stream.onended();
										}
									}
									lastTime = stream.currentTime;
								}, 500);
							}
						});
					} else {
						var error = new Error('NavigatorUserMediaError');
						error.name = 'Your version of Firefox does not support screen sharing, please install Firefox 33 (or more recent versions)';
						pluginHandle.consentDialog(false);
						callbacks.error(error);
						return;
					}
				}
				return;
			}
		}
		// If we got here, we're not screensharing
		if(!media || media.video !== 'screen') {
			// Check whether all media sources are actually available or not
			navigator.mediaDevices.enumerateDevices().then(function(devices) {
				var audioExist = devices.some(function(device) {
					return device.kind === 'audioinput';
				}),
				videoExist = isScreenSendEnabled(media) || devices.some(function(device) {
					return device.kind === 'videoinput';
				});

				// Check whether a missing device is really a problem
				var audioSend = isAudioSendEnabled(media);
				var videoSend = isVideoSendEnabled(media);
				var needAudioDevice = isAudioSendRequired(media);
				var needVideoDevice = isVideoSendRequired(media);
				if(audioSend || videoSend || needAudioDevice || needVideoDevice) {
					// We need to send either audio or video
					var haveAudioDevice = audioSend ? audioExist : false;
					var haveVideoDevice = videoSend ? videoExist : false;
					if(!haveAudioDevice && !haveVideoDevice) {
						// FIXME Should we really give up, or just assume recvonly for both?
						//pluginHandle.consentDialog(false);
						callbacks.error('No capture device found');
						return false;
					} else if(!haveAudioDevice && needAudioDevice) {
						//pluginHandle.consentDialog(false);
						callbacks.error('Audio capture is required, but no capture device found');
						return false;
					} else if(!haveVideoDevice && needVideoDevice) {
						//pluginHandle.consentDialog(false);
						callbacks.error('Video capture is required, but no capture device found');
						return false;
					}
				}

				var gumConstraints = {
					audio: (audioExist && !media.keepAudio) ? audioSupport : false,
					video: (videoExist && !media.keepVideo) ? videoSupport : false
				};
				Janus.debug("getUserMedia constraints", gumConstraints);
				if (!gumConstraints.audio && !gumConstraints.video) {
					//pluginHandle.consentDialog(false);
					streamsDone(handleId, jsep, media, callbacks, stream);
				} else {
					navigator.mediaDevices.getUserMedia(gumConstraints)
						.then(function(stream) {
							//pluginHandle.consentDialog(false);
							//streamsDone(handleId, jsep, media, callbacks, stream);
							streamsDone(jsep, media, callbacks, stream);
						}).catch(function(error) {
							//pluginHandle.consentDialog(false);
							callbacks.error({code: error.code, name: error.name, message: error.message});
						});
				}
			})
			.catch(function(error) {
				//pluginHandle.consentDialog(false);
				callbacks.error(error);
			});
		}
	} else {
		// No need to do a getUserMedia, create offer/answer right away
		//streamsDone(handleId, jsep, media, callbacks);
		streamsDone(jsep, media, callbacks);
	}
};


// Helper methods to parse a media object
function isAudioSendEnabled(media) {
	Janus.debug("isAudioSendEnabled:", media);
	if(!media)
		return true;	// Default
	if(media.audio === false)
		return false;	// Generic audio has precedence
	if(media.audioSend === undefined || media.audioSend === null)
		return true;	// Default
	return (media.audioSend === true);
}

function isAudioSendRequired(media) {
	Janus.debug("isAudioSendRequired:", media);
	if(!media)
		return false;	// Default
	if(media.audio === false || media.audioSend === false)
		return false;	// If we're not asking to capture audio, it's not required
	if(media.failIfNoAudio === undefined || media.failIfNoAudio === null)
		return false;	// Default
	return (media.failIfNoAudio === true);
}

function isAudioRecvEnabled(media) {
	Janus.debug("isAudioRecvEnabled:", media);
	if(!media)
		return true;	// Default
	if(media.audio === false)
		return false;	// Generic audio has precedence
	if(media.audioRecv === undefined || media.audioRecv === null)
		return true;	// Default
	return (media.audioRecv === true);
}

function isVideoSendEnabled(media) {
	Janus.debug("isVideoSendEnabled:", media);
	if(!media)
		return true;	// Default
	if(media.video === false)
		return false;	// Generic video has precedence
	if(media.videoSend === undefined || media.videoSend === null)
		return true;	// Default
	return (media.videoSend === true);
}

function isVideoSendRequired(media) {
	Janus.debug("isVideoSendRequired:", media);
	if(!media)
		return false;	// Default
	if(media.video === false || media.videoSend === false)
		return false;	// If we're not asking to capture video, it's not required
	if(media.failIfNoVideo === undefined || media.failIfNoVideo === null)
		return false;	// Default
	return (media.failIfNoVideo === true);
}

function isVideoRecvEnabled(media) {
	Janus.debug("isVideoRecvEnabled:", media);
	if(!media)
		return true;	// Default
	if(media.video === false)
		return false;	// Generic video has precedence
	if(media.videoRecv === undefined || media.videoRecv === null)
		return true;	// Default
	return (media.videoRecv === true);
}

function isScreenSendEnabled(media) {
	Janus.debug("isScreenSendEnabled:", media);
	if (!media)
		return false;
	if (typeof media.video !== 'object' || typeof media.video.mandatory !== 'object')
		return false;
	var constraints = media.video.mandatory;
	if (constraints.chromeMediaSource)
		return constraints.chromeMediaSource === 'desktop' || constraints.chromeMediaSource === 'screen';
	else if (constraints.mozMediaSource)
		return constraints.mozMediaSource === 'window' || constraints.mozMediaSource === 'screen';
	else if (constraints.mediaSource)
		return constraints.mediaSource === 'window' || constraints.mediaSource === 'screen';
	return false;
}

function isDataEnabled(media) {
	Janus.debug("isDataEnabled:", media);
	if(Janus.webRTCAdapter.browserDetails.browser === "edge") {
		Janus.warn("Edge doesn't support data channels yet");
		return false;
	}
	if(media === undefined || media === null)
		return false;	// Default
	return (media.data === true);
}

function isTrickleEnabled(trickle) {
	Janus.debug("isTrickleEnabled:", trickle);
	return (trickle === false) ? false : true;
}	


var webrtcStuff = {
	started : false,
	myStream : null,
	streamExternal : false,
	remoteStream : null,
	mySdp : null,
	mediaConstraints : null,
	pc : null,
	dataChannel : {},
	dtmfSender : null,
	trickle : true,
	iceDone : false,
	volume : {
		value : null,
		timer : null
	},
	bitrate : {
		value : null,
		bsnow : null,
		bsbefore : null,
		tsnow : null,
		tsbefore : null,
		timer : null
	}
};


function streamsDone(jsep, media, callbacks, stream) {
		var config = webrtcStuff;

		Janus.debug("streamsDone:", stream);
		if(stream) {
			Janus.debug("  -- Audio tracks:", stream.getAudioTracks());
			Janus.debug("  -- Video tracks:", stream.getVideoTracks());
		}
		// We're now capturing the new stream: check if we're updating or if it's a new thing
		var addTracks = false;
		if(!config.myStream || !media.update || config.streamExternal) {
			config.myStream = stream;
			addTracks = true;
		} else {
			// We only need to update the existing stream
			if(((!media.update && isAudioSendEnabled(media)) || (media.update && (media.addAudio || media.replaceAudio))) &&
					stream.getAudioTracks() && stream.getAudioTracks().length) {
				config.myStream.addTrack(stream.getAudioTracks()[0]);
				if(Janus.unifiedPlan) {
					// Use Transceivers
					Janus.log((media.replaceAudio ? "Replacing" : "Adding") + " audio track:", stream.getAudioTracks()[0]);
					var audioTransceiver = null;
					var transceivers = config.pc.getTransceivers();
					if(transceivers && transceivers.length > 0) {
						for(var t of transceivers) {
							if((t.sender && t.sender.track && t.sender.track.kind === "audio") ||
									(t.receiver && t.receiver.track && t.receiver.track.kind === "audio")) {
								audioTransceiver = t;
								break;
							}
						}
					}
					if(audioTransceiver && audioTransceiver.sender) {
						audioTransceiver.sender.replaceTrack(stream.getAudioTracks()[0]);
					} else {
						config.pc.addTrack(stream.getAudioTracks()[0], stream);
					}
				} else {
					Janus.log((media.replaceAudio ? "Replacing" : "Adding") + " audio track:", stream.getAudioTracks()[0]);
					config.pc.addTrack(stream.getAudioTracks()[0], stream);
				}
			}
			if(((!media.update && isVideoSendEnabled(media)) || (media.update && (media.addVideo || media.replaceVideo))) &&
					stream.getVideoTracks() && stream.getVideoTracks().length) {
				config.myStream.addTrack(stream.getVideoTracks()[0]);
				if(Janus.unifiedPlan) {
					// Use Transceivers
					Janus.log((media.replaceVideo ? "Replacing" : "Adding") + " video track:", stream.getVideoTracks()[0]);
					var videoTransceiver = null;
					var transceivers = config.pc.getTransceivers();
					if(transceivers && transceivers.length > 0) {
						for(var t of transceivers) {
							if((t.sender && t.sender.track && t.sender.track.kind === "video") ||
									(t.receiver && t.receiver.track && t.receiver.track.kind === "video")) {
								videoTransceiver = t;
								break;
							}
						}
					}
					if(videoTransceiver && videoTransceiver.sender) {
						videoTransceiver.sender.replaceTrack(stream.getVideoTracks()[0]);
					} else {
						config.pc.addTrack(stream.getVideoTracks()[0], stream);
					}
				} else {
					Janus.log((media.replaceVideo ? "Replacing" : "Adding") + " video track:", stream.getVideoTracks()[0]);
					config.pc.addTrack(stream.getVideoTracks()[0], stream);
				}
			}
		}

		if(addTracks && stream) {
			Janus.log('Adding local stream');
			var simulcast2 = (callbacks.simulcast2 === true);
			stream.getTracks().forEach(function(track) {
				Janus.log('Adding local track:', track);
			});
		}

		onlocalstream(config.myStream);

};



function onlocalstream(stream) {
	Janus.debug(" ::: Got a local stream :::", stream);
	if($('#myvideo').length === 0) {
		$('#videos').removeClass('hide').show();
		$('#videoleft').append('<video class="rounded centered" id="myvideo" width=320 height=240 autoplay playsinline muted="muted"/>');
	}
	Janus.attachMediaStream($('#myvideo').get(0), stream);
	$("#myvideo").get(0).muted = "muted";
	/*
	if(echotest.webrtcStuff.pc.iceConnectionState !== "completed" &&
			echotest.webrtcStuff.pc.iceConnectionState !== "connected") 
	*/
	if (true) {
		// No remote video yet
		$('#videoright').append('<video class="rounded centered" id="waitingvideo" width=320 height=240 />');
		if(spinner == null) {
			var target = document.getElementById('videoright');
			spinner = new Spinner({top:100}).spin(target);
		} else {
			spinner.spin();
		}
		var videoTracks = stream.getVideoTracks();
		if(!videoTracks || videoTracks.length === 0) {
			// No webcam
			$('#myvideo').hide();
			$('#videoleft').append(
				'<div class="no-video-container">' +
					'<i class="fa fa-video-camera fa-5 no-video-icon"></i>' +
					'<span class="no-video-text">No webcam available</span>' +
				'</div>');
		}
	}
	var videoTracks = stream.getVideoTracks();
	if(!videoTracks || videoTracks.length === 0) {
		// No webcam
		$('#myvideo').hide();
		if($('#videoleft .no-video-container').length === 0) {
			$('#videoleft').append(
				'<div class="no-video-container">' +
					'<i class="fa fa-video-camera fa-5 no-video-icon"></i>' +
					'<span class="no-video-text">No webcam available</span>' +
				'</div>');
		}
	} else {
		$('#videoleft .no-video-container').remove();
		$('#myvideo').removeClass('hide').show();
	}
	// Reset devices controls
	$('#audio-device, #video-device').removeAttr('disabled');
	$('#change-devices').removeAttr('disabled');
}



function Janus(gatewayCallbacks) {
	gatewayCallbacks = gatewayCallbacks || {};
	gatewayCallbacks.success = (typeof gatewayCallbacks.success == "function") ? gatewayCallbacks.success : Janus.noop;
	gatewayCallbacks.error = (typeof gatewayCallbacks.error == "function") ? gatewayCallbacks.error : Janus.noop;
	gatewayCallbacks.destroyed = (typeof gatewayCallbacks.destroyed == "function") ? gatewayCallbacks.destroyed : Janus.noop;
	if(!Janus.initDone) {
		gatewayCallbacks.error("Library not initialized");
		return {};
	}
	if(!Janus.isWebrtcSupported()) {
		gatewayCallbacks.error("WebRTC not supported by this browser");
		return {};
	}
	Janus.log("Library initialized: " + Janus.initDone);

}
