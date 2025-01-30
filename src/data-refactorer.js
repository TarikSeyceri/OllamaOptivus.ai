const IS_AUDIO_SPEECH_GUARANTEED = process.env.IS_AUDIO_SPEECH_GUARANTEED == "true";

function refactorMethod1(jsonData){
    let refactoredContent = [];
    
    // Iterate over the audio transcriptions and match frames based on the time intervals
    jsonData.audioTranscription.forEach(audio => {
        // Find frames that overlap with the current audio transcription
        let frameDetails = jsonData.frames.filter(frame => frame.timestamp >= audio.start && frame.timestamp < audio.end);

        // Create a combined object with detections and audio text for that time interval
        let audioContent = {
            startTimestamp: audio.start,
            endTimestamp: audio.end,
            audioTranscription: audio.text,
            screenTexts: new Set(),
            detections: new Set(),
        };

        // Combine all the detections in the frame for this period
        frameDetails.forEach(frame => {
            frame.texts.forEach(text => {
                audioContent.screenTexts.add(text);
            });
            frame.detections.forEach(detection => {
                audioContent.detections.add(detection);
            });
        });
        
        audioContent.screenTexts = [...audioContent.screenTexts];
        audioContent.detections = [...audioContent.detections];

        // Push the merged result for this audio segment
        refactoredContent.push(audioContent);
    });

    // Return the merged data
    return refactoredContent;
}

function refactorMethod2(jsonData){
    let refactoredContent = [];

    // Merging frames and audio transcriptions
    for (let i = 0; i < jsonData.frames.length; i++) {
		let frame = jsonData.frames[i];
		let audioText = jsonData.audioTranscription.find(item => item.start <= i && item.end > i);

		// Prevent duplicate audio transcriptions
		if(audioText){
			if(usedAudioTranscriptions[audioText.start] == audioText.end){
				audioText.text = "";
			}
			else {
				usedAudioTranscriptions[audioText.start] = audioText.end;
			}
		}
		  
		// If there is an audio transcription for the frame, merge it
		let frameContent = {
			timestamp: frame.timestamp,
			audioTranscription: audioText ? audioText.text : "",
			detections: Array.from(new Set(frame.detections)),
			screenTexts: Array.from(new Set(frame.texts)), 
		};

		let prevFrameContent = refactoredContent[refactoredContent.length-1];

		if(
			(
				(frameContent.audioTranscription == "" || frameContent?.audioTranscription == " ") && 
				frameContent.detections.length == 0 && 
				frameContent.screenTexts.length == 0
			) ||
			(
				prevFrameContent &&
				(frameContent.audioTranscription == "" || frameContent?.audioTranscription == " ") &&
				(
					(frameContent.detections.length == 0 && prevFrameContent.detections.length == 0) ||
					frameContent.detections.every(item => prevFrameContent.detections.includes(item))
				) &&
				(
					(frameContent.screenTexts.length == 0 && prevFrameContent.screenTexts.length == 0) ||
					frameContent.screenTexts.every(item => prevFrameContent.screenTexts.includes(item))
				)
			)
		){
			continue;
		}
		else if(
			prevFrameContent &&
			(prevFrameContent.audioTranscription == "" || prevFrameContent?.audioTranscription == " ") &&
			(
				(prevFrameContent.detections.length == 0 && frameContent.detections.length == 0) ||
				prevFrameContent.detections.every(item => frameContent.detections.includes(item))
			) &&
			(
				(prevFrameContent.screenTexts.length == 0 && frameContent.screenTexts.length == 0) ||
				prevFrameContent.screenTexts.every(item => frameContent.screenTexts.includes(item))
			)
		){
			refactoredContent[refactoredContent.length-1] = frameContent;
			continue;
		}

      	refactoredContent.push(frameContent);
    }

    // Return the merged data
    return refactoredContent;
}

function generatePrompt1(refactoredData){
    let prompt = `
    
    `;
    for(data of refactoredData){
        prompt = `${prompt}
            Between ${data.startTimestamp} and ${data.endTimestamp}, the following were detected:
            - ${data.detections.join(", ")}
        `;
        /*
        prompt += `Audio Transcription: ${data.audioTranscription}\n`;
        prompt += `Start Timestamp: ${data.startTimestamp}\n`;
        prompt += `End Timestamp: ${data.endTimestamp}\n`;
        prompt += `Screen Texts: ${data.screenTexts}\n`;
        prompt += `Detections: ${data.detections}\n\n`;
        */
    }
}

function generatePrompt2(refactoredData){

}

function refactorData(jsonData){
    if(IS_AUDIO_SPEECH_GUARANTEED){
        const refactoredData = refactorMethod1(jsonData);
    }
    else {
        const refactoredData = refactorMethod2(jsonData);
    }
}

module.exports = refactorData