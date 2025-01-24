from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import os
import subprocess
import shutil
import json
import threading
import time
import logging
from datetime import datetime, timedelta

# Load configuration
with open("config.json") as config_file:
    config = json.load(config_file)

UPLOAD_DIR = config.get("UPLOAD_DIR", "uploads")
MAX_UPLOAD_SIZE = config.get("MAX_UPLOAD_SIZE", 50 * 1024 * 1024)  # Default 50MB
BEARER_TOKEN = config.get("BEARER_TOKEN", "mysecrettoken")
FILE_RETENTION_DAYS = config.get("FILE_RETENTION_DAYS", 2)  # Default 2 days
LOG_RETENTION_DAYS = config.get("LOG_RETENTION_DAYS", 30)  # Default 30 days
APP_PORT = config.get("APP_PORT", 8000)  # Default port 8000
LOG_DIR = config.get("LOG_DIR", "logs")

# Ensure necessary directories exist
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(LOG_DIR, exist_ok=True)

# Setup logging
current_date = datetime.now().strftime("%Y-%m-%d")
log_file_path = os.path.join(LOG_DIR, f"{current_date}.log")
logging.basicConfig(
    filename=log_file_path,
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger()

def log_and_print(message):
    print(message)
    logger.info(message)

# Function to delete files older than retention period
def auto_delete_old_files():
    while True:
        now = datetime.now()
        for file_name in os.listdir(UPLOAD_DIR):
            file_path = os.path.join(UPLOAD_DIR, file_name)
            if os.path.isfile(file_path):
                file_age = now - datetime.fromtimestamp(os.path.getctime(file_path))
                if file_age > timedelta(days=FILE_RETENTION_DAYS):
                    os.remove(file_path)
                    log_and_print(f"Deleted old file: {file_name}")
        time.sleep(3600)  # Check every hour

# Function to delete old log files
def auto_delete_old_logs():
    while True:
        now = datetime.now()
        for log_file in os.listdir(LOG_DIR):
            log_file_path = os.path.join(LOG_DIR, log_file)
            if os.path.isfile(log_file_path):
                log_age = now - datetime.fromtimestamp(os.path.getctime(log_file_path))
                if log_age > timedelta(days=LOG_RETENTION_DAYS):
                    os.remove(log_file_path)
                    print(f"Deleted old log file: {log_file}")
        time.sleep(3600)  # Check every hour

# Start the auto-delete threads
threading.Thread(target=auto_delete_old_files, daemon=True).start()
threading.Thread(target=auto_delete_old_logs, daemon=True).start()

def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    if credentials.credentials != BEARER_TOKEN:
        raise HTTPException(status_code=403, detail="Invalid token")

app = FastAPI()
security = HTTPBearer()

@app.middleware("http")
async def log_requests(request: Request, call_next):
    logger.info(f"Incoming request: {request.method} {request.url}")
    response = await call_next(request)
    logger.info(f"Response status: {response.status_code}")
    return response

@app.post("/upload", dependencies=[Depends(verify_token)])
async def upload_video(file: UploadFile = File(...)):
    if file.size > MAX_UPLOAD_SIZE:
        raise HTTPException(status_code=400, detail="File size exceeds the maximum limit")

    file_path = os.path.join(UPLOAD_DIR, file.filename)
    with open(file_path, "wb") as f:
        shutil.copyfileobj(file.file, f)

    log_and_print(f"Uploaded file: {file.filename}")
    return {"video_path": file_path}

@app.get("/files", dependencies=[Depends(verify_token)])
def list_files():
    files = os.listdir(UPLOAD_DIR)
    log_and_print("Listed files")
    return {"files": files}

@app.delete("/delete", dependencies=[Depends(verify_token)])
def delete_file(file_path: str):
    full_path = os.path.join(UPLOAD_DIR, file_path)
    if not os.path.exists(full_path):
        raise HTTPException(status_code=404, detail="File not found")

    os.remove(full_path)
    log_and_print(f"Deleted file: {file_path}")
    return {"message": "File deleted successfully"}

@app.post("/process", dependencies=[Depends(verify_token)])
def process_file(file_path: str):
    full_path = os.path.join(UPLOAD_DIR, file_path)
    if not os.path.exists(full_path):
        raise HTTPException(status_code=404, detail="File not found")

    result = subprocess.run(["python3", "main.py", full_path], capture_output=True, text=True)

    if result.returncode != 0:
        log_and_print(f"Processing failed for file: {file_path}")
        raise HTTPException(status_code=500, detail=f"Processing failed: {result.stderr}")

    log_and_print(f"Processed file: {file_path}")
    return {"message": "Processing completed", "output": result.stdout}

if __name__ == "__main__":
    import uvicorn
    log_and_print(f"Starting server on port {APP_PORT}")
    uvicorn.run(app, host="0.0.0.0", port=APP_PORT)
