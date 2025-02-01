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

    const firstAudio = jsonData?.audioTranscription?.[0];
    if (firstAudio && firstAudio?.start != 0) {
      let audioContent = {
        startTimestamp: 0,
        endTimestamp: firstStartAudio.start,
        audioTranscription: "",
        screenTexts: new Set(),
        detections: new Set(),
      };

      let frameDetails = jsonData.frames.filter(frame => frame.timestamp >= 0 && frame.timestamp < firstAudio.start);

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
    }

    // Iterate over the audio transcriptions and match frames based on the time intervals
    jsonData.audioTranscription.forEach(audio => {
      // Create a combined object with detections and audio text for that time interval
      let audioContent = {
        startTimestamp: audio.start,
        endTimestamp: audio.end,
        audioTranscription: audio.text,
        screenTexts: new Set(),
        detections: new Set(),
      };

      // Find frames that overlap with the current audio transcription
      let frameDetails = jsonData.frames.filter(frame => frame.timestamp >= audio.start && frame.timestamp < audio.end);

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

    const lastAudio = jsonData?.audioTranscription?.[jsonData?.audioTranscription?.length - 1];
    const lastFrame = jsonData?.frames?.[jsonData?.frames?.length - 1];
    if (lastAudio && lastFrame && lastAudio?.end < lastFrame.timestamp) {
      let audioContent = {
        startTimestamp: lastAudio?.end,
        endTimestamp: lastFrame.timestamp,
        audioTranscription: "",
        screenTexts: new Set(),
        detections: new Set(),
      };

      let frameDetails = jsonData.frames.filter(frame => frame.timestamp > lastAudio?.end && frame.timestamp <= lastFrame.timestamp);

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
    }

    // Return the merged data
    return refactoredContent;
  };

  // Get the refactored content
  const refactoredContent = refactorData();

  // Now you can log or process the refactored data
  console.log(JSON.stringify(refactoredContent), refactoredContent.length);
});
