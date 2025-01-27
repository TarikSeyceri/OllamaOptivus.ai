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
        detections: frame.detections.map(detection => detection.class),
        screenTexts: frame.texts.map(t => t.text), 
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
				prevFrame.detections.join("") == frameContent.detections.join("") &&
				prevFrame.screenTexts.join("") == frameContent.screenTexts.join("") && 
				!frameContent.audioTranscription
			) ||
			(
				prevFrame &&
				(
					prevFrame.detections.join("") == frameContent.detections.join("") ||
					prevFrame.detections.includes(frameContent.detections)
				) &&
				frameContent.screenTexts.length == 0 &&
				!frameContent.audioTranscription
			)
		){
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