# Ollama Optivus AI

![alt OllamaOptivusAI](cover.webp)

## Overview

Ollama Optivus is a video processing AI based solution designed to analyze and extract meaningful information from video files. It uses a combination of technologies including computer vision (YOLO), optical character recognition (OCR), and speech-to-text transcription (Whisper).

It processes videos by extracting audio and analyzing the content frame-by-frame to identify text and objects. Then generates detailed information based on the analysis then forwards it to an Ollama Large Language Model.

## Features
- **Video Upload and Management**: Upload, List, and Delete video files from the server.

- **Video Processing**: Process video files by extracting audio, transcribing speech, detecting objects and texts in frames, and generating prompts to be used in an AI LLM.

- **AI LLM**: Integrated with Ollama for advanced AI-based processing, supports all ollama based models such as `deepseek-r1` or `llama3.2`.

## Video Processing Flow
1. **Video Upload**: Upload the video to the server.

2. **Audio Extraction**: FFmpeg is used to extract audio from the video file.

3. **Audio Transcription**: Whisper transcribes the extracted audio to text.

4. **Frame Extraction**: OpenCV Extracts frames from video to be analyzed one by one.

5. **Object Detection**: YOLOv8 detects objects in each frame of the video.

6. **Text Detection**: EasyOCR detects any text in each frame.

7. **AI Prompting**: Based on the extracted data, an AI model (Ollama) generates a detailed information, summarizing the video.


## Prerequisites

- [Ollama](https://ollama.com/download) (Required)
- [Docker](https://www.docker.com) OR ([Node.js](https://nodejs.org/en/download) v18.20.5 AND [Python](https://www.python.org/downloads/release/python-3119/) v3.11.9)

## Min. Hardware Requirements

- CPU: Octa-core (e.g., Intel Core i7, AMD Ryzen 7)
- GPU: Dedicated Nvidia 4 GB VRAM
- RAM: 16 GB
- SSD: 20 GB

## Installation

- Make sure [Ollama](https://ollama.com/download) is installed

- Clone the repository:

  ```bash
  git clone https://github.com/TarikSeyceri/OllamaOptivus.ai.git
  ```

  ```bash
  cd OllamaOptivus.ai
  ```

- There are two methods to install this project.
### A) Install Automatically Using Docker

- Before building and running the docker container, you may need to view [docker-compose.yml](docker-compose.yml) and add/change environment variables accordingly. You can view the default environment variables in [.env](.env), but don't change the variables inside `.env` file, just change/add them in `docker-compose.yml`

- Then:

  ```bash
  docker-compose up -d
  ```

### B) Install Manually On Local Machine

1. Download and Install [Node.js](https://nodejs.org/en/download) v18.20.5

2. Download and Install [Python](https://www.python.org/downloads/release/python-3119/) v3.11.9

3. Install Backend dependencies:

  ```bash
  npm install
  ```

4. Install Python dependencies:

  ```bash
  pip install -r requirements.txt
  ```

5. Modify environment variables in [.env](.env) file as needed, or leave them be.

6. Start the project:

  ```bash
  npm run start
  ```

> After running the project with either Docker or Locally. It will be accessable through: `http://localhost:3330`.


## Configuration

The [.env](.env) is straight forward self explanatory. You can access it and read it.

However, there are some important environment variables that i will be highlighting here:

- `NODE_ENV`: Set to `development` or `production`.
   - if set to `development`:
      - /swagger and /test endpoints will be enabled.
      - `HTTP_BEARER_TOKEN` authentication and rate limiting will not be active.

- `HTTP_BEARER_TOKEN`: Prestored token for authenticating API requests in production.

- `PROCESSING_ONLY`: If set to `true`, It will only allow video processing, it won't allow video listing, uploading or deleting. Should be enabled with `ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR`

- `ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR`: When set to `true`, It will allow `/process` endpoint to process videos from outside the project's `VIDEOS_DIR` folder, which means it can access other storage units such as usb, network or cloud storages, etc..

- `OLLAMA_AI_MODEL`: Set the Ollama AI Model to be used, default: `deepseek-r1`


## API Endpoints

- All endpoints are prepared in a [Postman Collection](OllamaOptivus.ai.postman_collection.json) which can be imported.

- In development environment `/swagger` endpoint is enabled which shows all available endpoints (Without authentication)

### 1. Upload Video

**POST** `/upload`

- Uploads a video file to the server.

- Video file must be `.mp4` file.

- Request Body: 
  > form-data with key `video` and value as the video file.

- Response Body: 
  ```bash
  {
    "success": true,
    "msg": "Video file uploaded!",
    "payload": {
      "videoFilePath": "data/videos/8047000029a4000c36b908dd2fd94b6e.mp4"
    }
  }
  ```

### 2. List Videos

**GET** `/videos`

- Lists all uploaded video files.
- Response Body: 
  ```bash
  {
    "success": true,
    "msg": "Video files listed!",
    "payload": {
        "videos": [
          "data/videos/8047000029a4000c36b908dd2fd94b6e.mp4"
        ]
    }
  }
  ```

### 3. Delete Video

**DELETE** `/delete`

- Deletes a video file from the server.

- Request Body:
  ```bash
  {
    "videoFileName": "8047000029a4000c36b908dd2fd94b6e.mp4"
  }
  ```

- Response Body: 
  ```bash
  {
    "success": true,
    "msg": "Video file deleted!"
  }
  ```

### 4. Process Video

**POST** `/process`

- Processes a video by analyzing its frames, extracting audio and transcribing it.

- Request Body: JSON with keys:
  - `videoFilePath`: Path to the video file. *(Required)*

  - `language`: Language for transcription. *('en' or 'tr' for now, Optional, default: "en")*

  - `videoExplanation`: Text explaining the context of the video. *(Optional, default: a proper general sentence)*

  - `temperature`: The creativity level for the AI model. *(optional, default: 0, means no creativity)*

  - `format`: The response format which is an ollama json response schema. *(Optional, default: { summary, events })*

  - `model`: The Ollama AI model to be used for prompting. *(Optional, default: env.OLLAMA_AI_MODEL)*

  - `noPrompting`: If `true`, it will return the processed data and skips the AI model prompting part, this means, format parameter will not be used, useful for debugging a video analysis *(Optional, default: false)*.

### Basic
- Request Body: Basic request body example:
  ```bash
  {
    "videoFilePath": "data/videos/8047000029a4000c61f808dd2fd54bb4.mp4"
  }
  ```
- Response Body:
  ```bash
  {
    "success": true,
    "msg": "Processing completed",
    "payload": {
      "response": "{ \"summary\": \"The conversation starts with verifying account details and setting up international transfers. The user is guided through the process, including adding recipient details and understanding fees. The assistant explains that there's a $15 fee for international transfers but a reduced $10 fee if using the mobile banking app. The conversation ends with thanking the user and providing final instructions.\", \"events\": [ { \"timestamp\": 2, \"description\": \"Verification of account balance\" }, { \"timestamp\": 4, \"description\": \"Setting up international transfer\" }, { \"timestamp\": 6, \"description\": \"Understanding fees for international transfers\" }, { \"timestamp\": 8, \"description\": \"Explaining the fee structure\" }, { \"timestamp\": 10, \"description\": \"Guiding through recipient setup\" }, { \"timestamp\": 12, \"description\": \"Clarifying if mobile app reduces fees\" }, { \"timestamp\": 14, \"description\": \"Confirming next steps\" } ] }\n\t\t \t\t\t\t\t\t\t\t\t\t\t\t\t\t \t "
    }
  }
  ```

### Standard
- Request Body: Standard request body example:
  ```bash
  {
    "videoFilePath": "data/videos/8047000029a4000c61f808dd2fd54bb4.mp4",
    "language": "en",
    "videoExplanation": "The following info is the output of an analysis of a video call conversation between an agent and customer:",
  }
  ```
- Response Body:
  ```bash
  # Same as above response
  ```

### Advanced
- Request Body: Advanced request body example: *(format schema is same as ollama's format schema)*
  ```bash
  {
    "videoFilePath": "data/videos/8047000029a4000c61f808dd2fd54bb4.mp4",
    "language": "en",
    "videoExplanation": "The following info is the output of an analysis of a video call conversation between an agent and customer:",
    "temperature": 0,
    "model": "deepseek-r1",
    "format": {
      "type": "object",
      "properties": {
        "summary": {
          "type": "string"
        },
        "isUnrespectfulConversation": {
          "type": "boolean"
        },
        "customerFraud": {
          "type": "object",
          "properties": {
              "percentage": {
                  "type": "number"
              },
              "reason": {
                  "type": "string"
              }
          },
          "required": ["percentage", "reason"]
        },
        "customerSatisfactionPercentage": {
          "type": "number"
        },
        "events": {
          "type": "array",
          "items": {
              "type": "object",
              "properties": {
                  "timestamp": {
                      "type": "number"
                  },
                  "description": {
                      "type": "string"
                  }
              },
              "required": ["timestamp", "description"]
          }
        }
      },
      "required": [
        "summary",
        "isUnrespectfulConversation",
        "customerFraud",
        "customerSatisfactionPercentage",
        "events"
      ]
    }
  }
  ```

- Response Body:
  ```bash
  {
    "success": true,
    "msg": "Processing completed",
    "payload": {
      "response": "{ \"summary\": \"The conversation starts with verifying account details and setting up international transfers. The user is guided through the process, including adding recipient details and understanding fees. The assistant explains that there's a $15 fee for international transfers but a reduced $10 fee if using the mobile banking app. The conversation ends with thanking the user and providing final instructions.\", \"isUnrespectfulConversation\": false, \"customerFraud\": {\"percentage\": 0, \"reason\": \"\"}, \"customerSatisfactionPercentage\": 95, \"events\": [ { \"timestamp\": 1576234800, \"description\": \"Verification of account balance completed successfully.\" }, { \"timestamp\": 1576234860, \"description\": \"Setting up international transfer requested by the customer.\" }, { \"timestamp\": 1576234920, \"description\": \"Customer informed about a $15 fee for international transfers.\" }, { \"timestamp\": 1576234980, \"description\": \"Explanation of reduced fee ($10) if using mobile banking app.\" }, { \"timestamp\": 1576235040, \"description\": \"Customer asked about setting up recipient details beforehand.\" }, { \"timestamp\": 1576235100, \"description\": \"Explanation of required steps for adding recipient details online.\" }, { \"timestamp\": 1576235160, \"description\": \"Guidance on receiving instructions via email or SMS.\" }, { \"timestamp\": 1576235220, \"description\": \"Customer thanks and requests further instructions sent to their email.\" }, { \"timestamp\": 1576235280, \"description\": \"Final instructions provided for completing the transfer setup.\" }, { \"timestamp\": 1576235340, \"description\": \"Completion of process and exit conversation.\" } ] }\n  \t \t \t \t \t \t \t \t \t\t"
    }
  }
  ```

### 5. Test Request (DevEnv)

**POST** `/test`

- Performs a test request

- Can be used to check some custom functionalities.

- Enabled only in `development` environment

- Request Body: `empty`
- Response Body: 
  ```bash
  # Anything // for testing and dev
  ```

## Logging

Winston, Morgan & Custom Python Logger are used for logging all important events and errors. Logs are stored in the `LOG_DIR` and rotated daily.

To check the logs:
```bash
tail -f data/logs/node_YYYY-MM-DD.log
```

```bash
tail -f data/logs/processor_YYYY-MM-DD.log
```

## Scheduling and File Retention

Every hour, the server checks the videos, audios, json, and prompts directories, deleting files older than the configured retention period, default: `2 days`.

## Tech Stack
- **Node.js**: Server-side JavaScript.
- **Express.js**: Web framework to handle HTTP requests.
- **Python**: To run complicated mathmatical libraries.
- **Swagger**: API documentation and testing tool.
- **Morgan**: Network Logging library.
- **Winston**: Logging library for managing logs.
- **OpenCV**: Computer vision library.
- **EasyOCR**: Optical Character Recognition (OCR) for text detection in video frames.
- **YOLOv8**: Object detection model for detecting objects in video frames.
- **FFmpeg**: Tool to extract audio from video.
- **Whisper**: OpenAI's model for transcribing audio to text.
- **Ollama**: Lightweight, extensible framework for building and running language models on local machines.
- **Docker**: Platform to containerize applications


## Contributing

I welcome contributions to Ollama Optivus AI! To contribute to this project, please follow these steps:

### How to Contribute

1. **Fork the Repository**:  
  Create a copy of the repository by clicking the "Fork" button in the top-right corner of the GitHub repository page.

2. **Clone Your Fork**:  
  Clone your forked repository to your local machine:
  ```bash
  git clone https://github.com/yourusername/OllamaOptivus.ai.git
  cd OllamaOptivus.ai
  ```

3. **Create a Branch**:  
  Create a new branch for your changes:
  ```bash
  git checkout -b feature/your-feature-name
  ```

4. **Make Changes**:  
  Implement your feature, fix a bug, or improve documentation. Be sure to write clear, concise commit messages.

5. **Run Tests**:  
  Ensure that all tests pass (if applicable). If you're adding new features, consider writing new tests.

6. **Commit Changes**:  
  After making your changes, commit them:
  ```bash
  git add .
  git commit -m "Add/Update [feature/fix]"
  ```

7. **Push to Your Fork**:  
  Push your changes back to your forked repository:
  ```bash
  git push origin feature/your-feature-name
  ```

8. **Submit a Pull Request (PR)**:  
  Open a pull request to the main repository. Provide a clear description of what changes you've made and why.

### Issues and Bug Reporting

If you find any issues or bugs in the project, please open an issue. Be sure to include as much detail as possible, including:
- A description of the issue
- Steps to reproduce the issue (if applicable)
- Any relevant logs or error messages

You can open an issue here: [Issues](https://github.com/TarikSeyceri/OllamaOptivus.ai/issues)

### Style Guide

- **JavaScript/Node.js**: I use [Airbnb's JavaScript Style Guide](https://github.com/airbnb/javascript). Please adhere to these conventions.
- **Python**: For python, i don't use a specific style, as long as it is easily readable.

### Documentation

If you add new feature or change existing functionality, please update the documentation accordingly. You can edit the `README.md` file directly or submit improvements for the project’s documentation.

