/*
 * File: testdevice.js
 * Desc: 
 * Auth: hongkuiyan@yeah.net
 * Date: 2021.7   
 */
var janus = null;
var firstTime = true;
var spinner = null;
var audioDeviceId = null;
var videoDeviceId = null;

var acodec = (getQueryStringValue("acodec") !== "" ? getQueryStringValue("acodec") : null);
var vcodec = (getQueryStringValue("vcodec") !== "" ? getQueryStringValue("vcodec") : null);
var vprofile = (getQueryStringValue("vprofile") !== "" ? getQueryStringValue("vprofile") : null);

// Helper method to prepare a UI selection of the avai,lable devices
function initDevices(devices, stream) {
	$('#devices').removeClass('hide');
	$('#devices').parent().removeClass('hide');
	$('#choose-device').click(restartCapture);
	var audio = $('#audio-device').val();
	var video = $('#video-device').val();
	$('#audio-device, #video-device').find('option').remove();

	devices.forEach(function(device) {
		var label = device.label;
		if(!label || label === "")
			label = device.deviceId;
		var option = $('<option value="' + device.deviceId + '">' + label + '</option>');
		if(device.kind === 'audioinput') {
			$('#audio-device').append(option);
		} else if(device.kind === 'videoinput') {
			$('#video-device').append(option);
		} else if(device.kind === 'audiooutput') {
			$('#output-devices').removeClass('hide');
			$('#audiooutput').append('<li><a href="#" id="' + device.deviceId + '">' + label + '</a></li>');
			$('#audiooutput a').unbind('click')
				.click(function() {
					var deviceId = $(this).attr("id");
					var label = $(this).text();
					Janus.log("Trying to set device " + deviceId + " (" + label + ") as sink for the output");
					if($('#peervideo').length === 0) {
						Janus.error("No remote video element available");
						bootbox.alert("No remote video element available");
						return false;
					}
					if(!$('#peervideo').get(0).setSinkId) {
						Janus.error("SetSinkId not supported");
						bootbox.warn("SetSinkId not supported");
						return false;
					}
					$('#peervideo').get(0).setSinkId(deviceId)
						.then(function() {
							Janus.log('Audio output device attached:', deviceId);
							$('#outputdeviceset').html(label + '<span class="caret"></span>').parent().removeClass('open');
						}).catch(function(error) {
							Janus.error(error);
							bootbox.alert(error);
						});
					return false;
				});
		}
	});

	$('#audio-device').val(audio);
	$('#video-device').val(video);
	$('#change-devices').click(function() {
		// A different device has been selected: hangup the session, and set it up again
		$('#audio-device, #video-device').attr('disabled', true);
		$('#change-devices').attr('disabled', true);
		if(firstTime) {
			firstTime = false;
			restartCapture(stream);
			return;
		}
		restartCapture(stream);
	});
}

function restartCapture(stream) {
	Janus.debug("Trying a createOffer too (audio/video sendrecv)");
	var replaceAudio = $('#audio-device').val() !== audioDeviceId;
	audioDeviceId = $('#audio-device').val();
	var replaceVideo = $('#video-device').val() !== videoDeviceId;
	videoDeviceId = $('#video-device').val();

	Janus.debug("present the localstream")
	createLocalStream(
		{
			// We provide a specific device ID for both audio and video
			media: {
				audio: {
					deviceId: {
						exact: audioDeviceId
					}
				},
				replaceAudio: replaceAudio, // This is only needed in case of a renegotiation
				video: {
					deviceId: {
						exact: videoDeviceId
					}
				},
				replaceVideo: replaceVideo, // This is only needed in case of a renegotiation
				data: true	// Let's negotiate data channels as well
			},
			success: function(jsep) {
				Janus.debug("Successful create local stream!", jsep);
			},
			error: function(error) {
				Janus.error("WebRTC error:", error);
				bootbox.alert("WebRTC error... " + error.message);
			}
		});
}

function  createLocalStream(callbacks) {
	return Janus.prepareLocalStream(true, callbacks); 
};

$(document).ready(function() {
	// Initialize the library (all console debuggers enabled)
	Janus.init({debug: "all", callback: function() {
		// Use a button to start the demo
		$('#start').one('click', function() {
			$(this).attr('disabled', true).unbind('click');
			$('#details').remove();
			// Enumerate devices: that's what we're here for
			Janus.listDevices(initDevices);
			
			// We wait for the user to select the first device before making a move
			$('#start').removeAttr('disabled').html("Stop")
				.click(function() {
				    $(this).attr('disabled', true);
						window.location.reload();
			});	
			Janus.log("Enumerating the device is complete!");

			
			$('#operation').removeClass('hide').show();
		});
	}});
});


// Helper to parse query string
function getQueryStringValue(name) {
	name = name.replace(/[\[]/, "\\[").replace(/[\]]/, "\\]");
	var regex = new RegExp("[\\?&]" + name + "=([^&#]*)"),
		results = regex.exec(location.search);
	return results === null ? "" : decodeURIComponent(results[1].replace(/\+/g, " "));
}