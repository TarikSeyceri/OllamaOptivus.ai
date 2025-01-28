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
			timestamp: i,
			audioTranscription: audioText ? audioText.text : '',
			detections: Array.from(new Set(frame.detections.map(detection => detection.class))),
			screenTexts: Array.from(new Set(frame.texts.map(t => t.text))), 
		};

		let prevFrame = refactoredContent[refactoredContent.length-1];
		if(
			(
				(frameContent.audioTranscription == "" || frameContent?.audioTranscription == " ") && 
				frameContent.detections.length == 0 && 
				frameContent.screenTexts.length == 0
			) ||
			(
				prevFrame &&
				(
					prevFrame.detections.join("") == frameContent.detections.join("") ||
					prevFrame.detections.every(item => frameContent.detections.includes(item))
				) &&
				(
					prevFrame.screenTexts.join("") == frameContent.screenTexts.join("") ||
					prevFrame.screenTexts.every(item => frameContent.screenTexts.includes(item))
				) &&
				!frameContent.audioTranscription
			)
		){
			continue;
		}
		else if(
			prevFrame &&
			(
				frameContent.detections.join("") == prevFrame.detections.join("") ||
				frameContent.detections.every(item => prevFrame.detections.includes(item))
			) &&
			(
				frameContent.screenTexts.join("") == prevFrame.screenTexts.join("") ||
				frameContent.screenTexts.every(item => prevFrame.screenTexts.includes(item))
			) &&
			!prevFrame.audioTranscription
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
  console.log(JSON.stringify(refactoredContent, null, 2));
});