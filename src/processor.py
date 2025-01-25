import argparse
from dotenv import load_dotenv
import cv2
from ultralytics import YOLO
import easyocr
import whisper
import os
import sys
import json
import logging
import warnings
from datetime import datetime

# Create logs folder
if not os.path.exists("logs"):
    os.makedirs("logs")

logFile = f"logs/processor_{datetime.now().strftime('%Y-%m-%d')}.log"
logHandler = logging.FileHandler(logFile, mode='a')
logHandler.setLevel(logging.DEBUG)
logHandler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))

logging.getLogger("easyocr").addHandler(logHandler)
logging.getLogger("whisper").addHandler(logHandler)
logging.getLogger("ultralytics").addHandler(logHandler)
logging.getLogger("cv2").addHandler(logHandler)

logging.getLogger("easyocr").setLevel(logging.ERROR)
logging.getLogger("whisper").setLevel(logging.ERROR)
logging.getLogger("ultralytics").setLevel(logging.ERROR)
logging.getLogger("cv2").setLevel(logging.ERROR)
warnings.filterwarnings("ignore")
logging.captureWarnings(True)

# Set up argparse to accept videoPath as a parameter
parser = argparse.ArgumentParser(description="Process a video file.")
parser.add_argument("videoPath", type=str, help="Path to the input video file")
args = parser.parse_args()

if not args.videoPath:
    print("Error: Video path is null or empty.")
    sys.exit(1)  # Exit with error code

if not os.path.exists(args.videoPath):
    print("Error: Video file does not exist.")
    sys.exit(1)  # Exit with error code

load_dotenv()

# Load the YOLOv8 model
yoloModel = YOLO("yolov8n.pt") 

# Load the EasyOCR model
ocrReader = easyocr.Reader([os.getenv("PROCESSING_LANGUAGE", "en")]) # , 'de', 'ar' #ValueError: Arabic is only compatible with English, try lang_list=["ar","fa","ur","ug","en"]

# Load Whisper model
whisperModel = whisper.load_model(os.getenv("PROCESSING_WHISPER_MODEL", "base"))  # Choose model size: tiny, base, small, medium, large

# Create audios folder
if not os.path.exists("audios"):
    os.makedirs("audios")

# Extract audio from the video
audioPath = "audios/"+ os.path.splitext(os.path.basename(args.videoPath))[0] + ".wav"
if not os.path.exists(audioPath):
    os.system(f"ffmpeg -i {args.videoPath} -q:a 0 -map a {audioPath} -y -loglevel quiet")

if not os.path.exists(audioPath):
    print("Error: Could not extract audio from the video.")
    sys.exit(1)

# Transcribe audio using Whisper
audioTranscription = whisperModel.transcribe(audioPath, language=os.getenv("PROCESSING_LANGUAGE", "en"))

# Remove the audio file after transcription
if os.path.exists(audioPath):
    os.remove(audioPath)

# Open the video file
video = cv2.VideoCapture(args.videoPath)

# Check if the video file is opened
if not video.isOpened():
    print("Error: Could not open video file.")
    sys.exit(1)

# Get video properties
fps = int(video.get(cv2.CAP_PROP_FPS))  # Original FPS of the video
frameSkip = fps * os.getenv("PROCESSING_FPS", 1)  # Number of frames to skip for 1 FPS processing // `fps * 2` => 1 frame every 2 seconds // `fps // 2` => 2 frames per second

frameCount = 0

detectionResults = {
    "frames": [],
    "audioTranscription": audioTranscription['segments']
}

# Process each frame of the video
while True:
    # Skip frames to achieve 1 FPS
    video.set(cv2.CAP_PROP_POS_FRAMES, frameCount * frameSkip)
    ret, frame = video.read()
    if not ret:
        break  # Break the loop if no frames are left

    # Perform object detection
    yoloModelResults = yoloModel(frame)

    # Collect detections for the current frame
    frameData = {
        "frame": frameCount,
        "detections": [],
        "texts": [],
    }

    for result in yoloModelResults:
        for box in result.boxes:
            #print(f"Detected {yoloModel.names[int(box.cls[0].item())]} with confidence {box.conf[0].item()}")
            #x_min, y_min, x_max, y_max = map(int, box.xyxy[0])  # Bounding box coordinates
            frameData["detections"].append({
                "class": yoloModel.names[int(box.cls[0].item())],  # Detected class name
                "confidence": float(box.conf[0].item()),  # Confidence score
            })

    ocrResults = ocrReader.readtext(frame)
    for (bbox, text, confidence) in ocrResults:
        #print(f"Detected text: {text} (Confidence: {confidence:.2f})")
        frameData["texts"].append({
            "text": text,
            "confidence": f"{confidence:.2f}"
        })
    
    detectionResults["frames"].append(frameData)
    frameCount += 1

# Release video capture
video.release()

# Print detection results
print(json.dumps(detectionResults))

# Success exit code
sys.exit(0)