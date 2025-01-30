const fs = require('fs');

// Read the JSON file
fs.readFile('./data.json', 'utf8', (err, data) => {
  if (err) {
    console.error("Error reading file:", err);
    return;
  }

  const jsonData = JSON.parse(data);
  let usedAudioTranscriptions = {};

  // Function to merge frame data with audio transcription
  const refactorData = () => {
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
  };

  // Get the refactored content
  const refactoredContent = refactorData();
  
  //for(

  // Now you can log or process the refactored data
  console.log(refactoredContent, refactoredContent.length);
});