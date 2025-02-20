# Ollama Optivus AI

![alt OllamaOptivusAI](cover.webp)

## Overview

Ollama Optivus is a video processing AI based solution designed to analyze and extract meaningful information from video files. It uses a combination of technologies including computer vision (YOLO), optical character recognition (OCR), and speech-to-text transcription (Whisper).

It processes videos by extracting audio and analyzing the content frame-by-frame to identify text and objects. Then generates detailed information based on the analysis then forwards it to an Ollama Large Language Model.

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
### A) Automatically Using Docker

- Before building and running the docker container, you may need to view [docker-compose.yml](blob/main/docker-compose.yml) and add/change environment variables accordingly. You can view the default environment variables in [.env](blob/main/.env), but don't change the variables inside `.env` file, just change/add them in `docker-compose.yml`

- Then:

```bash
docker-compose up -d
```

### B) Manually On Local Machine

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

5. Modify environment variables in [.env](blob/main/.env) file as needed, or leave them be.

6. Start the project:

```bash
npm run start
```

> After running the project with either Docker or Locally. It will be accessable through: `http://localhost:3330`.


## Configuration

The [.env](blob/main/.env) is straight forward self explanatory. You can access it and read it.

However, there are some important environment variables that i will be highlighting here:

- `NODE_ENV`: Set to `development` or `production`.
   - if set to `development`:
      - /swagger and /test endpoints will be enabled.
      - `HTTP_BEARER_TOKEN` authentication and rate limiting will not be active.
- `HTTP_BEARER_TOKEN`: Prestored token for authenticating API requests in production.
- `PROCESSING_ONLY`: If set to `true`, It will only allow video processing, it won't allow video listing, uploading or deleting. Should be enabled with `ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR`
- `ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR`: When set to `true`, It will allow `/process` endpoint to process videos from outside the project's `VIDEOS_DIR` folder, which means it can access other storages such as usb or network storages, etc..
- `OLLAMA_AI_MODEL`: Set the Ollama AI Model to be used, default: `deepseek-r1`





## Features
- **Video Upload and Management**: Upload and list video files, and delete them from the server.
- **Video Processing**: Process video files by extracting audio, transcribing speech, detecting objects and texts in frames, and generating prompts to be used in AI models.
- **AI Models**: Integrates with Ollama for advanced AI-based processing, supports all ollama based models such as `deepseek-r1` or `llama3.2`.
- **Swagger UI**: Provides API documentation and testing interface.
- **Postman Collection**: Provides already prepared API requests.

## Tech Stack
- **Node.js**: Server-side JavaScript.
- **Express.js**: Web framework to handle HTTP requests.
- **YOLOv8**: Object detection model for detecting objects in video frames.
- **EasyOCR**: Optical Character Recognition (OCR) for text detection in video frames.
- **Whisper**: OpenAI's model for transcribing audio to text.
- **FFmpeg**: Tool to extract audio from video.
- **Swagger UI**: API documentation and testing tool.
- **Winston**: Logging library for managing logs.

6. Visit `http://localhost:3330/swagger` to access the Swagger UI for API documentation.





## API Endpoints

### 1. Upload Video

**POST** `/upload`

- Uploads a video file to the server.
- Request Body: Form-data with key `video` and value as the video file.

### 2. List Videos

**GET** `/videos`

- Lists all uploaded video files.

### 3. Delete Video

**DELETE** `/delete`

- Deletes a video file from the server.
- Request Body: JSON with key `videoFileName` (e.g., `"video.mp4"`).

### 4. Process Video

**POST** `/process`

- Processes a video by extracting audio, transcribing it, and analyzing the frames.
- Request Body: JSON with keys:
  - `videoFilePath`: Path to the video file.
  - `language`: Language for transcription (default: `en`).
  - `videoExplanation`: Optional text explaining the context of the video.
  - `model`: The AI model to use for processing.
  - `temperature`: The creativity level for the AI model.
  - `format`: The response format.
  - `noPrompting`: If `true`, skips the AI model prompting.

### 5. Test Request (DevEnv)

**POST** `/test`

- Performs a test request for development environment.
- Can be used to check the processing functionality without any specific video file.

### Swagger Documentation

The Swagger UI for this API is available at:  
`http://localhost:3330/swagger`

It allows you to explore and test all the available API endpoints.

## Video Processing Flow

1. **Video Upload**: Upload the video to the server.
2. **Audio Extraction**: FFmpeg is used to extract audio from the video file.
3. **Audio Transcription**: Whisper transcribes the extracted audio to text.
4. **Object Detection**: YOLOv8 detects objects in each frame of the video.
5. **Text Detection**: EasyOCR detects any text in the frames.
6. **AI Prompt Generation**: Based on the extracted data, an AI model (Ollama) generates a detailed prompt, summarizing the video and detected objects.
7. **Data Storage**: Processed data is stored in the `JSON_DATA_DIR` directory.

## Logging

Winston is used for logging all important events and errors. Logs are stored in the `LOG_DIR` and rotated daily.

To check the logs:
```bash
tail -f data/logs/node_YYYY-MM-DD.log
```

## Scheduling and File Retention

Every hour, the server checks the video, audio, JSON, and prompt directories, deleting files older than the configured retention period.

## Development

## License

MIT License. See `LICENSE` for more information.
