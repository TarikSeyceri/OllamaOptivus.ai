import argparse
from dotenv import load_dotenv
import cv2
from ultralytics import YOLO
import easyocr
import whisper
import ffmpeg
import os
import sys
import json
import logging
import warnings
from datetime import datetime
import sys
import types
import time

# Load environment variables
load_dotenv()

LOG_DIR = os.getenv("LOG_DIR", "logs")
LOG_RETENTION_DAYS = os.getenv("LOG_RETENTION_DAYS", 30)
PROCESSING_LOG_LEVEL = os.getenv("PROCESSING_LOG_LEVEL", "WARNING")
PROCESSING_LANGUAGE = os.getenv("PROCESSING_LANGUAGE", "en")
PROCESSING_WHISPER_MODEL = os.getenv("PROCESSING_WHISPER_MODEL", "base")
PROCESSING_FPS = os.getenv("PROCESSING_FPS", 1)

#----------------------------------------------------
# Set up argparse to accept videoPath as a parameter
#----------------------------------------------------
parser = argparse.ArgumentParser(description="Process a video file.")
parser.add_argument("videoPath", type=str, help="Path to the input video file")
args = parser.parse_args()

if not args.videoPath:
    print("Error: Video path is null or empty.")
    sys.exit(1)  # Exit with error code

if not os.path.exists(args.videoPath):
    print("Error: Video file does not exist.")
    sys.exit(1)  # Exit with error code

#----------------------------------------------------
# Set up logging
#----------------------------------------------------
if not os.path.exists(LOG_DIR):
    os.makedirs(LOG_DIR)

class VideoNameFilter(logging.Filter):
    def filter(self, record):
        record.videoName = args.videoPath  # Add videoName as an attribute to the record
        return record
    
def getLogLevel(level):
    # Map the string to its logging level
    levels = {
        'CRITICAL': logging.CRITICAL,
        'ERROR': logging.ERROR,
        'WARNING': logging.WARNING,
        'INFO': logging.INFO,
        'DEBUG': logging.DEBUG,
        'NOTSET': logging.NOTSET
    }
    
    return levels.get(level.upper(), logging.NOTSET)
    
logFile = f"{LOG_DIR}/processor_{datetime.now().strftime('%Y-%m-%d')}.log"
logLevel = getLogLevel(PROCESSING_LOG_LEVEL)
logHandler = logging.FileHandler(logFile, mode='a')
logHandler.setLevel(logLevel)
logHandler.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(videoName)s - %(message)s'))
logHandler.addFilter(VideoNameFilter()) 

logger = logging.getLogger()
logger.setLevel(logLevel)
logger.addHandler(logHandler)

def setupLogger():
    for name, module in sys.modules.items():
        # Only set up logging for modules that have a logger
        if isinstance(module, types.ModuleType):
            logger = logging.getLogger(name)
            if logger.hasHandlers():
                for handler in logger.handlers[:]:
                    logger.removeHandler(handler)
            # Add the file handler to the logger
            logger.addHandler(logHandler)
            logger.propagate = False
setupLogger()

warnings.filterwarnings("ignore")
logging.captureWarnings(True)

def logFilesRetention(directory=LOG_DIR, days_old=LOG_RETENTION_DAYS):
    # Get the current time
    current_time = time.time()
    
    # Iterate through all files in the logs directory
    for filename in os.listdir(directory):
        file_path = os.path.join(directory, filename)
        
        # Check if the file is a log file and if it's older than the specified number of days
        if filename.endswith('.log') and os.path.isfile(file_path):
            file_mod_time = os.path.getmtime(file_path)
            if (current_time - file_mod_time) // (24 * 3600) >= days_old:
                logger.warning(f"Deleting old log file: {filename}")
                os.remove(file_path)
logFilesRetention()

#----------------------------------------------------
# Main processing logic
#----------------------------------------------------
logger.warning("Processing started")

# Load the YOLOv8 model
yoloModel = YOLO("yolov8n.pt") 

# Load the EasyOCR model
ocrReader = easyocr.Reader([PROCESSING_LANGUAGE]) # , 'de', 'ar' #ValueError: Arabic is only compatible with English, try lang_list=["ar","fa","ur","ug","en"]

# Load Whisper model
whisperModel = whisper.load_model(PROCESSING_WHISPER_MODEL)  # Choose model size: tiny, base, small, medium, large

# Create audios folder
if not os.path.exists("audios"):
    os.makedirs("audios")

# Extract audio from the video
audioPath = "audios/"+ os.path.splitext(os.path.basename(args.videoPath))[0] + ".wav"
if not os.path.exists(audioPath):
    ffmpeg.input(args.videoPath).output(audioPath, q='0', map='a', y=None, loglevel='quiet').run()

if not os.path.exists(audioPath):
    print("Error: Could not extract audio from the video.")
    sys.exit(1)

# Transcribe audio using Whisper
audioTranscription = whisperModel.transcribe(audioPath, language=PROCESSING_LANGUAGE)

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
frameSkip = fps * PROCESSING_FPS  # Number of frames to skip for 1 FPS processing // `fps * 2` => 1 frame every 2 seconds // `fps // 2` => 2 frames per second

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
jsonResults = json.dumps(detectionResults)
logger.debug(jsonResults)
print(jsonResults)

# Log the end of the processing
logger.warning("Processing successfully completed")

# Success exit code
sys.exit(0)