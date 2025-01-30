const fs = require('fs');

// Read the JSON file
fs.readFile('./data.json', 'utf8', (err, data) => {
  if (err) {
    console.error("Error reading file:", err);
    return;
  }

  const jsonData = JSON.parse(data);

  // Function to merge frame data based on audio transcription
  const refactorData = () => {
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
  };

  // Get the refactored content
  const refactoredContent = refactorData();

  // Now you can log or process the refactored data
  console.log(refactoredContent, refactoredContent.length);
});
