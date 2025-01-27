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
      let frameDetails = jsonData.frames.filter(frame => frame.frame >= audio.start && frame.frame < audio.end);

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
			audioContent.screenTexts.add(text.text);
        });
        frame.detections.forEach(detection => {
          // Use detection class as detection label
          audioContent.detections.add(detection.class);
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
  console.log(JSON.stringify(refactoredContent, null, 2));
});
