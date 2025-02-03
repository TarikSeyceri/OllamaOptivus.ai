const IS_AUDIO_SPEECH_GUARANTEED = process.env.IS_AUDIO_SPEECH_GUARANTEED == "true";
const PROCESSING_LANGUAGE = process.env.PROCESSING_LANGUAGE || "en";

const languages = {
    en: {
        videoExplanation: "The following info is the output of an analysis of a video call conversation between an agent and customer:",
        betweenSecond: "Between second",
        andSecond: "and second",
        audioTranscription: "Audio transcription",
        onScreenText: "On screen text",
        objectsDetected: "Objects detected",
        atSecond: "At second",
        detectedObjects: "Detected objects in the video",
    },
    tr: {
        videoExplanation: "Aşağıdaki bilgiler, bir temsilci ile müşteri arasındaki bir görüntülü görüşme görüşmesinin analizinin çıktısıdır:",
        betweenSecond: "Arasında saniye",
        andSecond: "ve saniye",
        audioTranscription: "Ses transkripsiyonu",
        onScreenText: "Ekrandaki metin",
        objectsDetected: "Algılanan nesneler",
        atSecond: "Saniye",
        detectedObjects: "Videoda algılanan nesneler",
    }
}
const language = languages[PROCESSING_LANGUAGE] || languages.en;

function refactorMethod1(jsonData) {
    let refactoredData = [];

    const firstAudio = jsonData?.audioTranscription?.[0];
    if (firstAudio && firstAudio?.start != 0) {
        let frameContent = {
            startTimestamp: 0,
            endTimestamp: firstStartAudio.start,
            audioTranscription: "",
            onScreenTexts: new Set(),
            detections: new Set(),
        };

        let frames = jsonData.frames.filter(frame => frame.timestamp >= 0 && frame.timestamp < firstAudio.start);

        frames.forEach(frame => {
            frame.texts.forEach(text => {
                frameContent.onScreenTexts.add(text);
            });
            frame.detections.forEach(detection => {
                frameContent.detections.add(detection);
            });
        });

        frameContent.onScreenTexts = [...frameContent.onScreenTexts];
        frameContent.detections = [...frameContent.detections];

        // Push the merged result for this audio segment
        refactoredData.push(frameContent);
    }

    // Iterate over the audio transcriptions and match frames based on the time intervals
    jsonData.audioTranscription.forEach(audio => {
        // Create a combined object with detections and audio text for that time interval
        let audioContent = {
            startTimestamp: audio.start,
            endTimestamp: audio.end,
            audioTranscription: audio.text,
            onScreenTexts: new Set(),
            detections: new Set(),
        };

        // Find frames that overlap with the current audio transcription
        let frames = jsonData.frames.filter(frame => frame.timestamp >= audio.start && frame.timestamp < audio.end);

        // Combine all the detections in the frame for this period
        frames.forEach(frame => {
            frame.texts.forEach(text => {
                audioContent.onScreenTexts.add(text);
            });
            frame.detections.forEach(detection => {
                audioContent.detections.add(detection);
            });
        });

        audioContent.onScreenTexts = [...audioContent.onScreenTexts];
        audioContent.detections = [...audioContent.detections];

        // Push the merged result for this audio segment
        refactoredData.push(audioContent);
    });

    const lastAudio = jsonData?.audioTranscription?.[jsonData?.audioTranscription?.length - 1];
    const lastFrame = jsonData?.frames?.[jsonData?.frames?.length - 1];
    if (lastAudio && lastFrame && lastAudio?.end < lastFrame.timestamp) {
        let frameContent = {
            startTimestamp: lastAudio?.end,
            endTimestamp: lastFrame.timestamp,
            audioTranscription: "",
            onScreenTexts: new Set(),
            detections: new Set(),
        };

        let frames = jsonData.frames.filter(frame => frame.timestamp > lastAudio?.end && frame.timestamp <= lastFrame.timestamp);

        frames.forEach(frame => {
            frame.texts.forEach(text => {
                frameContent.onScreenTexts.add(text);
            });
            frame.detections.forEach(detection => {
                frameContent.detections.add(detection);
            });
        });

        frameContent.onScreenTexts = [...frameContent.onScreenTexts];
        frameContent.detections = [...frameContent.detections];

        // Push the merged result for this audio segment
        refactoredData.push(frameContent);
    }

    // Return the merged data
    return refactoredData;
}

function refactorMethod2(jsonData) {
    let refactoredData = [];
    let usedAudioTranscriptions = {};

    // Merging frames and audio transcriptions
    for (const frame of jsonData?.frames) {
        let audioText = jsonData.audioTranscription.find(item => item.start <= frame.timestamp && item.end > frame.timestamp);

        // Prevent duplicate audio transcriptions
        if (audioText) {
            if (usedAudioTranscriptions[audioText.start] == audioText.end) {
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
            onScreenTexts: Array.from(new Set(frame.texts)),
        };

        let prevFrameContent = refactoredData[refactoredData.length - 1];

        if (
            (
                (frameContent.audioTranscription == "" || frameContent?.audioTranscription == " ") &&
                frameContent.detections.length == 0 &&
                frameContent.onScreenTexts.length == 0
            ) ||
            (
                prevFrameContent &&
                (frameContent.audioTranscription == "" || frameContent?.audioTranscription == " ") &&
                (
                    (frameContent.detections.length == 0 && prevFrameContent.detections.length == 0) ||
                    frameContent.detections.every(item => prevFrameContent.detections.includes(item))
                ) &&
                (
                    (frameContent.onScreenTexts.length == 0 && prevFrameContent.onScreenTexts.length == 0) ||
                    frameContent.onScreenTexts.every(item => prevFrameContent.onScreenTexts.includes(item))
                )
            )
        ) {
            continue;
        }
        else if (
            prevFrameContent &&
            (prevFrameContent.audioTranscription == "" || prevFrameContent?.audioTranscription == " ") &&
            (
                (prevFrameContent.detections.length == 0 && frameContent.detections.length == 0) ||
                prevFrameContent.detections.every(item => frameContent.detections.includes(item))
            ) &&
            (
                (prevFrameContent.onScreenTexts.length == 0 && frameContent.onScreenTexts.length == 0) ||
                prevFrameContent.onScreenTexts.every(item => frameContent.onScreenTexts.includes(item))
            )
        ) {
            refactoredData[refactoredData.length - 1] = frameContent;
            continue;
        }

        refactoredData.push(frameContent);
    }

    // Return the merged data
    return refactoredData;
}

function refactorMethod3(jsonData) {
    let refactoredData = [];
    let usedAudioTranscriptions = {};
    let detections = [];

    // Merging frames and audio transcriptions
    for (const frame of jsonData?.frames) {
        let audioText = jsonData.audioTranscription.find(item => item.start <= frame.timestamp && item.end > frame.timestamp);

        // Prevent duplicate audio transcriptions
        if (audioText) {
            if (usedAudioTranscriptions[audioText.start] == audioText.end) {
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
            onScreenTexts: Array.from(new Set(frame.texts)),
        };

        detections = detections.concat(frame.detections);

        let prevFrameContent = refactoredData[refactoredData.length - 1];

        if (
            (
                (frameContent.audioTranscription == "" || frameContent?.audioTranscription == " ") &&
                frameContent.onScreenTexts.length == 0
            ) ||
            (
                prevFrameContent &&
                (frameContent.audioTranscription == "" || frameContent?.audioTranscription == " ") &&
                (
                    (frameContent.onScreenTexts.length == 0 && prevFrameContent.onScreenTexts.length == 0) ||
                    frameContent.onScreenTexts.every(item => prevFrameContent.onScreenTexts.includes(item))
                )
            )
        ) {
            continue;
        }
        else if (
            prevFrameContent &&
            (prevFrameContent.audioTranscription == "" || prevFrameContent?.audioTranscription == " ") &&
            (
                (prevFrameContent.onScreenTexts.length == 0 && frameContent.onScreenTexts.length == 0) ||
                prevFrameContent.onScreenTexts.every(item => frameContent.onScreenTexts.includes(item))
            )
        ) {
            refactoredData[refactoredData.length - 1] = frameContent;
            continue;
        }

        refactoredData.push(frameContent);
    }

    // Return the merged data
    return { refactoredData, detections: Array.from(new Set(detections)) };
}

function clearBackgroundOnScreenTextsData(refactoredData){
    // Getting rid of onScreenTests that are too common // Possibly background Texts
    let onScreenTextsToDiscard = {};
    let onScreenTextsCount = 0;
    for (let data of refactoredData) {
        if(data.onScreenTexts.length > 0){
            const text = data.onScreenTexts.join(", ");
            if(onScreenTextsToDiscard[text])onScreenTextsToDiscard[text]++;
            else onScreenTextsToDiscard[text] = 1;
            onScreenTextsCount++;
        }
    }

    //console.log(onScreenTextsToDiscard, onScreenTextsCount);

    let onScreenTextsToFinalize = [];
    for(let text in onScreenTextsToDiscard){
        //console.log(onScreenTextsCount / onScreenTextsToDiscard[text], onScreenTextsCount / onScreenTextsToDiscard[text] <= 4);
        if(onScreenTextsCount / onScreenTextsToDiscard[text] <= 4){
            onScreenTextsToFinalize.push(text);
        }
    }
    
    //console.log(onScreenTextsToFinalize);

    if(onScreenTextsToFinalize.length > 0){
        for (let data of refactoredData) {
            if(data.onScreenTexts.length > 0){
                const text = data.onScreenTexts.join(", ");
                if(onScreenTextsToFinalize.includes(text)){
                    data.onScreenTexts = [];
                } 
            }
        }
    }
    // End of getting rid of onScreenTests that are too common // Possibly background Texts

    return refactoredData;
}

function generatePrompt1(refactoredData) {
    refactoredData = clearBackgroundOnScreenTextsData(refactoredData);

    let prompt = `${language.videoExplanation}`;
    for (let data of refactoredData) {
        prompt = `${prompt}
${language.betweenSecond} ${data.startTimestamp} ${language.andSecond} ${data.endTimestamp}${data.audioTranscription != "" && data.audioTranscription != " " ? ", ${language.audioTranscription}:" + data.audioTranscription : ""}${data.onScreenTexts.length > 0 ? ". ${language.onScreenText}: " + data.onScreenTexts.join(", ") + "." : ""}${data.detections.length > 0 ? ". ${language.objectsDetected}: " + data.detections.join(", ") + "." : ""}`;
    }

    return prompt
}

function generatePrompt2(refactoredData) {
    refactoredData = clearBackgroundOnScreenTextsData(refactoredData);

    let prompt = `${language.videoExplanation}`;
    for (let data of refactoredData) {
        prompt = `${prompt}
${language.atSecond} ${data.timestamp}${data.audioTranscription != "" && data.audioTranscription != " " ? ", ${language.audioTranscription}:" + data.audioTranscription : ""}${data.onScreenTexts.length > 0 ? ". ${language.onScreenText}: " + data.onScreenTexts.join(", ") + "." : ""}${data.detections.length > 0 ? ". ${language.objectsDetected}: " + data.detections.join(", ") + "." : ""}`;
    }

    return prompt
}

function generatePrompt3(reworkedData) {
    reworkedData.refactoredData = clearBackgroundOnScreenTextsData(reworkedData.refactoredData);

    let prompt = `${language.videoExplanation}`;
    
    for (let data of reworkedData.refactoredData) {
        if(data.audioTranscription != "" && data.audioTranscription != " "){
            prompt = `${prompt}
${language.atSecond} ${data.timestamp}, ${language.audioTranscription}: ${data.audioTranscription}`;
        }
        if(data.onScreenTexts.length > 0){
            prompt = `${prompt}
${language.atSecond} ${data.timestamp}, ${language.onScreenText}: ${data.onScreenTexts.join(", ")}.`;
        }
    }

    prompt = `${prompt}
${language.detectedObjects}: ${reworkedData.detections.join(", ")}.`;
    return prompt
}

function getPrompt(jsonData) {
    if (IS_AUDIO_SPEECH_GUARANTEED) {
        return generatePrompt3(refactorMethod3(jsonData));
    }
    else {
        return generatePrompt2(refactorMethod2(jsonData));
    }
}

module.exports = { getPrompt };
