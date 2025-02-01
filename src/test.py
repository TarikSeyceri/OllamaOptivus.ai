import json

detectionResults = {
  "frames": [
    {
      "timestamp": 0,
      "detections": [],
      "texts": []
    },
    {
      "timestamp": 6,
      "detections": [],
      "texts": [
        "Navteq call example",
        "Building Rapport",
        "Assuming the Sale",
        "Overcoming Objections"
      ]
    },
    {
      "timestamp": 16,
      "detections": [
        "person",
        "cup",
        "mouse",
        "chair"
      ],
      "texts": []
    }
  ],
  "audioTranscription": [
    {
      "start": 0,
      "end": 11,
      "text": " Thank you for calling. My name is Lauren. Can I have your name?"
    },
    {
      "start": 11,
      "end": 16,
      "text": " My name is John Smith. Thank you, John. How can I help you?"
    }
  ]
}

print(json.dumps(detectionResults))