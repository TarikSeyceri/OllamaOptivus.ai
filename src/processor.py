import cv2
import json
from ultralytics import YOLO
import easyocr
import whisper
import os

# Load the YOLOv8 model
model = YOLO("yolov8n.pt")  # Replace 'yolov8n.pt' with the path to your model if different
ocrReader = easyocr.Reader(['en', 'tr']) # , 'de', 'ar' #ValueError: Arabic is only compatible with English, try lang_list=["ar","fa","ur","ug","en"]

# Load Whisper model
whisper_model = whisper.load_model("large")  # Choose model size: tiny, base, small, medium, large

# Define the input video file
video_path = "8047000029a4000c61f808dd2fd54bb4.mp4"  # Replace with your video file path
output_json = "output_data.json"

# Extract audio from the video
audio_path = "audio_temp.wav"

if not os.path.exists(audio_path):
    os.system(f"ffmpeg -i {video_path} -q:a 0 -map a {audio_path} -y")

# Transcribe audio using Whisper
audio_transcription = whisper_model.transcribe(audio_path, language="en")
#print(f"Transcribed audio: {audio_transcription['text']}")

if os.path.exists(audio_path):
    os.remove(audio_path)

# Open the video file
cap = cv2.VideoCapture(video_path)

# Check if the video file is opened
if not cap.isOpened():
    print("Error: Could not open video file.")
    exit()

# Get video properties
fps = int(cap.get(cv2.CAP_PROP_FPS))  # Original FPS of the video
frame_skip = fps  # Number of frames to skip for 1 FPS processing // `fps * 2` => 1 frame every 2 seconds // `fps // 2` => 2 frames per second

frame_count = 0
detection_results = {
    "frames": [],
    "audio_transcription": audio_transcription['text']
}

# Process each frame of the video
while True:
    # Skip frames to achieve 1 FPS
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_count * frame_skip)
    ret, frame = cap.read()
    if not ret:
        break  # Break the loop if no frames are left

    # Perform object detection
    results = model(frame)

    # Collect detections for the current frame
    frame_data = {
        "frame": frame_count,
        "detections": [],
        "texts": [],
    }

    for result in results:
        for box in result.boxes:
            x_min, y_min, x_max, y_max = map(int, box.xyxy[0])  # Bounding box coordinates
            frame_data["detections"].append({
                "class": model.names[int(box.cls[0].item())],  # Detected class name
                "confidence": float(box.conf[0].item()),  # Confidence score
            })
            
            
    ocr_result = ocrReader.readtext(frame)
    for (bbox, text, confidence) in ocr_result:
        print(f"Detected text: {text} (Confidence: {confidence:.2f})")
        frame_data["texts"].append({
            "text": text,
            "confidence": f"{confidence:.2f}"
        })
    
    detection_results["frames"].append(frame_data)
    frame_count += 1

# Release video capture
cap.release()

# Save results to a JSON file
with open(output_json, "w") as json_file:
    json.dump(detection_results, json_file, indent=4)

print(f"Detection results saved to {output_json}.")
