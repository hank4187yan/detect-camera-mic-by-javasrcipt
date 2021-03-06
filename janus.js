/*
 * File: testdevice.js
 * Desc: 
 * Auth: hongkuiyan@yeah.net
 * Date: 2021.7   
 */

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

// For snapshot
var btn_new_photo = null;
var btn_download  = null;
var btn_start_rec = null;
var btn_stop_rec  = null;
var canvas_photo  = null;
var camera_overview = null; 

// For record
var preview = null;
var recording = null; 
var startButton = null;
var stopButton = null;
var downloadButton = null;
var logElement = null;
var timestamp = null;

var recordingTimeMS = 1 * 60 * 1000;  // 1min

var recorder;
var intervalId = null;
var record_status = false;  // 是否正在录制

var stream = null;


// List of sessions
Janus.sessions = {};
Janus.noop = function() {};

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
		Janus.initDone = true;
		options.callback();
	}
};

// Helper method to check whether devices can be accessed by this browser (e.g., not possible via plain HTTP)
Janus.isGetUserMediaAvailable = function() {
	return navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
};

Janus.prepareLocalStream = function(offer, callbacks) {
	callbacks = callbacks || {};
	callbacks.success = (typeof callbacks.success == "function") ? callbacks.success : Janus.noop;
	callbacks.error = (typeof callbacks.error == "function") ? callbacks.error : webrtcError;
	
	
	var jsep = callbacks.jsep;
	/* Check that callbacks.media is a (not null) Object  */
	callbacks.media = (typeof callbacks.media === 'object' && callbacks.media) ? callbacks.media : { audio: true, video: true };
	var media = callbacks.media;

	// Nope, new PeerConnection
	media.update = false;
	media.keepAudio = false;
	media.keepVideo = false;

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
                Janus.log("Unsupport media.video:", media.video);
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
					streamsDone(jsep, media, callbacks, stream);
				} else {
					navigator.mediaDevices.getUserMedia(gumConstraints)
						.then(function(stream) {
							streamsDone(jsep, media, callbacks, stream);
						}).catch(function(error) {
							callbacks.error({code: error.code, name: error.name, message: error.message});
						});
				}
			})
			.catch(function(error) {
				callbacks.error(error);
			});
		}
	} else {
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
			//var simulcast2 = (callbacks.simulcast2 === true);
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
		$('#record').removeClass('hide').show();
	}

	// Reset devices controls
	$('#audio-device, #video-device').removeAttr('disabled');
	$('#change-devices').removeAttr('disabled');

	// For snapshot
	btn_new_photo = document.querySelector('#newphoto');
	btn_download  = document.querySelector('#download');
	camera_overview=document.querySelector('video');
	canvas_photo  = document.querySelector('canvas');
	
	camera_overview.srcObject = stream;
	btn_new_photo.onclick = snapshot_photo;
	btn_download.onclick  = download_photo;
	
	camera_overview.onloadedmetadata = function() {
		camera_overview.setAttribute("width", this.videoWidth);
		camera_overview.setAttribute("height", this.videoHeight);
		canvas_photo.setAttribute("width", this.videoWidth);
		canvas_photo.setAttribute("height", this.videoHeight);
		Janus.log("Video source width: ", this.videoWidth);
		Janus.log("Video source height:", this.videoHeight);
	};
		

	// For record 
	/*
	let media_recorder = new MediaRecorder(stream);
	media_recorder.ondataavailable = function(blob) {
			console.log(blob.data);
	}
	media_recorder.start(1000);
	*/
	preview = document.getElementById("preview");
	recording = document.getElementById("recording");
	startButton = document.getElementById("startButton");
	stopButton = document.getElementById("stopButton");
	downloadButton = document.getElementById("downloadButton");
	logElement = document.getElementById("log");
	timestamp = document.getElementById("timestamp");

	startButton.addEventListener("click", function () {
		navigator.mediaDevices.getUserMedia({
			video: true,
			audio: true
		}).then(mystream => {
			configUi("start");
			preview.srcObject = stream;
			downloadButton.href = stream;
			preview.captureStream = preview.captureStream || preview.mozCaptureStream;
			return new Promise(resolve => preview.onplaying = resolve);
		}).then(() => startRecording(preview.captureStream(), recordingTimeMS))
			.then(recordedChunks => {
				console.log(recordedChunks);
				let recordedBlob = new Blob(recordedChunks, {type: "video/webm"});
				recording.src = URL.createObjectURL(recordedBlob);
				downloadButton.href = recording.src;
				downloadButton.download = "RecordedVideo.webm";
				log("Successfully recorded " + recordedBlob.size + " bytes of " +
					recordedBlob.type + " media.");
			})
			.catch(log);
	}, false);
	
	stopButton.addEventListener("click", function () {
		stop(preview.srcObject);
	}, false);

}

// For snapshot
function snapshot_photo() {
	canvas_photo.getContext("2d").drawImage(camera_overview, 0, 0, camera_overview.width, camera_overview.height);
		btn_download.removeAttribute("disabled");
};
  
function download_photo() {
	canvas_photo.toBlob(function (blob) {
	  var link = document.createElement("a");
	  link.download = "photo.jpg";
	  link.setAttribute("href", URL.createObjectURL(blob));
	  link.dispatchEvent(new MouseEvent("click"));
	}, "image/jpeg", 1);
};


/* For record */
function configUi(operator_type) {
    if (operator_type === 'start') {
        timestamp.innerText = `00:00`;
        record_status = true;
        let timeStamp = 1;
        intervalId = setInterval(() => {
            const min = Math.floor(timeStamp / 60);
            const sec = timeStamp % 60;
            timestamp.innerText = `${min > 9 ? min : ("0" + min)}:${sec > 10 ? sec : ("0" + sec)}`;
            timeStamp += 1;
        }, 1000);
        removeClass(preview, 'hide');  // 预览的显示
        addClass(recording, 'hide');  // 播放的隐藏
        addClass(startButton, 'hide');  // 开始按钮隐藏
        removeClass(stopButton, 'hide');  // 结束按钮显示
    } else {
        if (record_status === true) {
            record_status = false;
            intervalId && clearInterval(intervalId);
            addClass(preview, 'hide');  // 预览的隐藏
            removeClass(recording, 'hide');  // 播放的显示
            removeClass(startButton, 'hide');  // 开始按钮显示
            removeClass(downloadButton, 'hide');  // 下载按钮显示
            addClass(stopButton, 'hide');  // 结束按钮隐藏
        }
    }
    return true;
};

function addClass(ele, className) {
    ele.classList.add(className);
};

function removeClass(ele, className) {
    ele.classList.remove(className);
};

function log(msg) {
    logElement.innerHTML += msg + "\n";
};

function wait(delayInMS) {
    return new Promise(resolve => setTimeout(resolve, delayInMS));
};

function startRecording(stream, lengthInMS) {
    recorder = new MediaRecorder(stream);
    let data = [];

    recorder.ondataavailable = event => data.push(event.data);
    recorder.start();
    log(recorder.state + " for " + (lengthInMS / 1000) + " seconds...");

    let stopped = new Promise((resolve, reject) => {
        recorder.onstop = resolve;
        recorder.onerror = event => reject(event.name);
    });

    let recorded = wait(lengthInMS).then(() => {
            return recorder.state === "recording" && configUi("stop") && recorder.stop();
        }
    );

    return Promise.all([
        stopped
        // recorded
    ])
        .then(() => data);
};

function stop(stream) {
    configUi('stop');
    stream.getTracks().forEach(track => track.stop());
    recorder.state === "recording" && recorder.stop();
};


function Janus(gatewayCallbacks) {
	gatewayCallbacks = gatewayCallbacks || {};
	gatewayCallbacks.success = (typeof gatewayCallbacks.success == "function") ? gatewayCallbacks.success : Janus.noop;
	gatewayCallbacks.error = (typeof gatewayCallbacks.error == "function") ? gatewayCallbacks.error : Janus.noop;
	gatewayCallbacks.destroyed = (typeof gatewayCallbacks.destroyed == "function") ? gatewayCallbacks.destroyed : Janus.noop;
	if(!Janus.initDone) {
		gatewayCallbacks.error("Library not initialized");
		return {};
	}
	Janus.log("Library initialized: " + Janus.initDone);
}