"""Legacy one-shot video analysis script (v1 pipeline).

Usage: python processor.py <videoPath> <language>
Prints one JSON document {"frames": [...], "audioTranscription": [...]} on stdout and exits 0.
On failure it prints a message on stderr and exits non-zero.

v2 replaces this script with the persistent GPU worker service in worker/.
"""

import os
import sys

# Keep stdout clean for the JSON result: everything any library prints (also from C extensions)
# goes to stderr instead. The real stdout stays reachable through RESULT_OUT.
RESULT_OUT = os.fdopen(os.dup(1), "w", encoding="utf-8")
os.dup2(2, 1)
sys.stdout = sys.stderr

from dotenv import load_dotenv  # noqa: E402

load_dotenv()
PROCESSING_VERBOSE = os.getenv("PROCESSING_VERBOSE", "false").lower() == "true"
if not PROCESSING_VERBOSE:
    os.environ["YOLO_VERBOSE"] = "False"
    os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"

import argparse  # noqa: E402
import hashlib  # noqa: E402
import json  # noqa: E402
import logging  # noqa: E402
import math  # noqa: E402
import time  # noqa: E402
import warnings  # noqa: E402
from datetime import datetime  # noqa: E402

import cv2  # noqa: E402
import easyocr  # noqa: E402
import ffmpeg  # noqa: E402
import whisper  # noqa: E402
from ultralytics import YOLO  # noqa: E402

# ----------------------------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------------------------
LOG_DIR = os.getenv("LOG_DIR", "data/logs")
LOG_RETENTION_DAYS = int(os.getenv("LOG_RETENTION_DAYS", "30"))
AUDIOS_DIR = os.getenv("AUDIOS_DIR", "data/audios")
JSON_DATA_DIR = os.getenv("JSON_DATA_DIR", "data/json")
PROCESSING_LOG_LEVEL = os.getenv("PROCESSING_LOG_LEVEL", "WARNING").upper()
PROCESSING_WHISPER_MODEL = os.getenv("PROCESSING_WHISPER_MODEL", "base")
PROCESSING_FPS = float(os.getenv("PROCESSING_FPS", "1"))
if not math.isfinite(PROCESSING_FPS) or PROCESSING_FPS <= 0:
    PROCESSING_FPS = 1.0

parser = argparse.ArgumentParser(description="Analyze a video file.")
parser.add_argument("videoPath", type=str, help="Path to the input video file")
parser.add_argument("language", type=str, help="Language of the speech and on-screen text (e.g. en, tr)")
args = parser.parse_args()


def fail(message: str) -> None:
    sys.stderr.write(f"Error: {message}\n")
    sys.stderr.flush()
    sys.exit(1)


if not args.videoPath or not os.path.isfile(args.videoPath):
    fail("Video file does not exist.")
if not args.language:
    fail("Language is empty.")

# ----------------------------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------------------------
os.makedirs(LOG_DIR, exist_ok=True)


class VideoNameFilter(logging.Filter):
    def filter(self, record):
        record.videoName = args.videoPath
        return True


logHandler = logging.FileHandler(f"{LOG_DIR}/processor_{datetime.now().strftime('%Y-%m-%d')}.log", mode="a", encoding="utf-8")
logHandler.setLevel(getattr(logging, PROCESSING_LOG_LEVEL, logging.WARNING))
logHandler.setFormatter(logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(videoName)s - %(message)s"))
logHandler.addFilter(VideoNameFilter())
logger = logging.getLogger("processor")
logger.setLevel(getattr(logging, PROCESSING_LOG_LEVEL, logging.WARNING))
logger.addHandler(logHandler)
logger.propagate = False

warnings.filterwarnings("ignore")
logging.captureWarnings(True)


def delete_old_logs(directory=LOG_DIR, days_old=LOG_RETENTION_DAYS):
    now = time.time()
    for filename in os.listdir(directory):
        file_path = os.path.join(directory, filename)
        if filename.endswith(".log") and os.path.isfile(file_path) and (now - os.path.getmtime(file_path)) // 86400 >= days_old:
            logger.warning(f"Deleting old log file: {filename}")
            os.remove(file_path)


delete_old_logs()


def write_atomically(path: str, content: str) -> None:
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(content)
    os.replace(tmp, path)


# ----------------------------------------------------------------------------------------------
# Cache: keyed by name + content fingerprint (size, mtime) + language + sampling rate, so a
# different video with the same file name never reuses another video's analysis.
# ----------------------------------------------------------------------------------------------
logger.warning("Processing started")
stat = os.stat(args.videoPath)
fingerprint = hashlib.sha256(f"{os.path.realpath(args.videoPath)}|{stat.st_size}|{stat.st_mtime_ns}".encode()).hexdigest()[:12]
stem = os.path.splitext(os.path.basename(args.videoPath))[0]
os.makedirs(JSON_DATA_DIR, exist_ok=True)
os.makedirs(AUDIOS_DIR, exist_ok=True)
jsonDataPath = os.path.join(JSON_DATA_DIR, f"{stem}.{fingerprint}.{args.language}.fps{PROCESSING_FPS:g}.json")

if os.path.exists(jsonDataPath):
    try:
        with open(jsonDataPath, encoding="utf-8") as cached:
            content = cached.read()
        json.loads(content)  # never serve a damaged cache entry
        RESULT_OUT.write(content)
        RESULT_OUT.flush()
        logger.warning("The video was already processed before; served from cache.")
        sys.exit(0)
    except (OSError, ValueError):
        logger.warning("Ignoring unreadable cache entry %s", jsonDataPath)

# ----------------------------------------------------------------------------------------------
# Audio: first audio stream only, mono 16 kHz (what Whisper uses). Videos without audio are fine.
# ----------------------------------------------------------------------------------------------
try:
    probe = ffmpeg.probe(args.videoPath)
except ffmpeg.Error as error:
    fail(f"Could not read the video file: {error.stderr.decode(errors='replace') if error.stderr else error}")

has_audio = any(stream.get("codec_type") == "audio" for stream in probe.get("streams", []))
filteredAudioTranscription = []
if has_audio:
    audioPath = os.path.join(AUDIOS_DIR, f"{stem}.{fingerprint}.wav")
    if not os.path.exists(audioPath):
        tmpAudio = f"{audioPath}.{os.getpid()}.tmp.wav"
        (
            ffmpeg.input(args.videoPath)
            .output(tmpAudio, map="0:a:0", ac=1, ar=16000, loglevel="info" if PROCESSING_VERBOSE else "error")
            .overwrite_output()
            .run(quiet=not PROCESSING_VERBOSE)
        )
        os.replace(tmpAudio, audioPath)
        logger.debug("Audio extracted successfully")

    whisperModel = whisper.load_model(PROCESSING_WHISPER_MODEL)
    logger.debug("Whisper model loaded successfully")
    audioTranscription = whisperModel.transcribe(audioPath, language=args.language, verbose=None)
    filteredAudioTranscription = [
        {"start": round(float(item["start"]), 2), "end": round(float(item["end"]), 2), "text": item["text"]}
        for item in audioTranscription["segments"]
    ]
    logger.debug("Audio transcribed successfully")
else:
    logger.warning("The video has no audio stream; skipping transcription.")

# ----------------------------------------------------------------------------------------------
# Frames: decode sequentially and sample by time (no seeking, no frame-rate drift).
# ----------------------------------------------------------------------------------------------
yoloModel = YOLO(os.path.join(os.path.dirname(os.path.abspath(__file__)), "yolov8n.pt"))
ocrLanguages = [args.language] if args.language == "en" else [args.language, "en"]
ocrReader = easyocr.Reader(ocrLanguages, verbose=PROCESSING_VERBOSE)
logger.debug("YOLO and EasyOCR models loaded successfully")

video = cv2.VideoCapture(args.videoPath)
if not video.isOpened():
    fail("Could not open video file.")

fps = video.get(cv2.CAP_PROP_FPS)
if not math.isfinite(fps) or fps <= 0:
    fps = 25.0

detectionResults = {"frames": [], "audioTranscription": filteredAudioTranscription}
interval = 1.0 / PROCESSING_FPS
next_sample = 0.0
frame_index = 0
while video.grab():
    t = frame_index / fps
    frame_index += 1
    if t + 1e-6 < next_sample:
        continue
    while next_sample <= t + 1e-6:
        next_sample += interval
    ok, frame = video.retrieve()
    if not ok:
        continue

    frameData = {"timestamp": round(t, 2), "detections": [], "texts": []}
    for result in yoloModel(frame, verbose=False):
        for box in result.boxes:
            frameData["detections"].append(yoloModel.names[int(box.cls[0].item())])
    for (_bbox, text, _confidence) in ocrReader.readtext(frame):
        frameData["texts"].append(text)
    detectionResults["frames"].append(frameData)

video.release()
logger.debug("Video file closed successfully")

jsonResults = json.dumps(detectionResults)
write_atomically(jsonDataPath, jsonResults)
RESULT_OUT.write(jsonResults)
RESULT_OUT.flush()
logger.warning("Processing successfully completed")
sys.exit(0)
