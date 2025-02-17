import os
os.environ['YOLO_VERBOSE'] = 'False'
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'
import argparse
from dotenv import load_dotenv
import cv2
from ultralytics import YOLO
import easyocr
import whisper
import ffmpeg
import sys
import json
import logging
import warnings
from datetime import datetime
import sys
import types
import time
from fer import FER

#----------------------------------------------------
# Load environment variables
#----------------------------------------------------
load_dotenv()

LOG_DIR = os.getenv("LOG_DIR", "data/logs")
LOG_RETENTION_DAYS = int(os.getenv("LOG_RETENTION_DAYS", 30))
AUDIOS_DIR = os.getenv("AUDIOS_DIR", "data/audios")
JSON_DATA_DIR = os.getenv("JSON_DATA_DIR", "data/json")
PROCESSING_LOG_LEVEL = os.getenv("PROCESSING_LOG_LEVEL", "WARNING")
PROCESSING_WHISPER_MODEL = os.getenv("PROCESSING_WHISPER_MODEL", "base")
PROCESSING_FPS = int(os.getenv("PROCESSING_FPS", 1))

#----------------------------------------------------
# Set up argparse to accept videoPath as a parameter
#----------------------------------------------------
parser = argparse.ArgumentParser(description="Process a video file.")
parser.add_argument("videoPath", type=str, help="Path to the input video file")
parser.add_argument("language", type=str, help="Language for processing the video")
args = parser.parse_args()

if not args.videoPath:
    print("Error: Video path is null or empty.")
    sys.exit(1)  # Exit with error code

if not args.language:
    print("Error: Language is null or empty.")
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

# Check if the JSON data file already exists # Then no need to process the video again
jsonDataPath = JSON_DATA_DIR + '/'+os.path.splitext(os.path.basename(args.videoPath))[0]+'_'+args.language+'.json'
if os.path.exists(jsonDataPath):
    try:
        with open(jsonDataPath, 'r') as file:
            content = file.read()
            print(content)
            logger.warning("Processing successfully completed")
            sys.exit(0)
    except Exception:
        pass

# Load the YOLOv8 model
yoloModel = YOLO(os.path.dirname(os.path.abspath(__file__)) + "/yolov8n.pt") 

# Load the EasyOCR model
ocrReader = easyocr.Reader([args.language], verbose=False) # , 'de', 'ar' #ValueError: Arabic is only compatible with English, try lang_list=["ar","fa","ur","ug","en"]

# Disabling stdout and stderr
original_stdout = sys.stdout
original_stderr = sys.stderr
sys.stdout = open(os.devnull, 'w')
sys.stderr = open(os.devnull, 'w')

# Load Whisper model
whisperModel = whisper.load_model(PROCESSING_WHISPER_MODEL)  # Choose model size: tiny, base, small, medium, large

# Re-enable stdout and stderr
sys.stdout = original_stdout
sys.stderr = original_stderr

# Initialize emotion detector
emotionDetector = FER()

# Create audios folder
if not os.path.exists(AUDIOS_DIR):
    os.makedirs(AUDIOS_DIR)

# Extract audio from the video
audioPath = AUDIOS_DIR+"/"+ os.path.splitext(os.path.basename(args.videoPath))[0] + ".wav"
if not os.path.exists(audioPath):
    ffmpeg.input(args.videoPath).output(audioPath, q='0', map='a', y=None, loglevel='quiet').run()

if not os.path.exists(audioPath):
    print("Error: Could not extract audio from the video.")
    sys.exit(1)

# Transcribe audio using Whisper
audioTranscription = whisperModel.transcribe(audioPath, language=args.language)
filteredAudioTranscription = [
    {"start": int(item["start"]), "end": int(item["end"]), "text": item["text"]} for item in audioTranscription['segments']
]

# Open the video file
video = cv2.VideoCapture(args.videoPath)

# Check if the video file is opened
if not video.isOpened():
    print("Error: Could not open video file.")
    sys.exit(1)

# Initialize the detection results
detectionResults = {
    "frames": [],
    "audioTranscription": filteredAudioTranscription
}

# Get video properties
fps = int(video.get(cv2.CAP_PROP_FPS))  # Original FPS of the video
frameSkip = int(fps / PROCESSING_FPS)  # Skip frames based on desired processing FPS
frameCount = 0

# Scene change detection
# Function to compute histogram similarity
def calc_histogram_similarity(frame1, frame2):
    hist1 = cv2.calcHist([frame1], [0], None, [256], [0, 256])
    hist2 = cv2.calcHist([frame2], [0], None, [256], [0, 256])
    return cv2.compareHist(hist1, hist2, cv2.HISTCMP_CORREL)

_, prev_frame = video.read()

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
        "timestamp": frameCount * (1 / PROCESSING_FPS),
        "detections": [],
        "texts": [],
        "emotions": [],
        "isSceneChanged": False
    }

    for result in yoloModelResults:
        for box in result.boxes:
            #print(f"Detected {yoloModel.names[int(box.cls[0].item())]} with confidence {box.conf[0].item()}")
            #x_min, y_min, x_max, y_max = map(int, box.xyxy[0])  # Bounding box coordinates
            '''
            frameData["detections"].append({
                "class": yoloModel.names[int(box.cls[0].item())],  # Detected class name
                "confidence": float(box.conf[0].item()),  # Confidence score
            })
            '''
            frameData["detections"].append(yoloModel.names[int(box.cls[0].item())])

    ocrResults = ocrReader.readtext(frame)
    for (bbox, text, confidence) in ocrResults:
        #print(f"Detected text: {text} (Confidence: {confidence:.2f})")
        '''
        frameData["texts"].append({
            "text": text,
            "confidence": f"{confidence:.2f}"
        })
        '''
        frameData["texts"].append(text)

    emotion, score = emotionDetector.top_emotion(frame)
    frameData["emotions"].append(emotion)

    # Scene change detection
    # Convert frames to grayscale for easier processing
    prev_gray = cv2.cvtColor(prev_frame, cv2.COLOR_BGR2GRAY)
    curr_gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    # Calculate similarity
    similarity = calc_histogram_similarity(prev_gray, curr_gray)

    # If the similarity is low, it indicates a scene change
    if similarity < 0.7:
        frameData["isSceneChanged"] = True
    
    detectionResults["frames"].append(frameData)
    frameCount += 1
    prev_frame = frame

# Release video capture
video.release()

# Print detection results
jsonResults = json.dumps(detectionResults)
logger.debug(jsonResults)
print(jsonResults)

with open(jsonDataPath, 'w') as jsonDataFile:
    jsonDataFile.write(jsonResults)

# Log the end of the processing
logger.warning("Processing successfully completed")

# Success exit code
sys.exit(0)