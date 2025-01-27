import json

detectionResults = {
    "frames": [1, 2, 3],
    "audioTranscription": "Ok"
}

print(json.dumps(detectionResults))