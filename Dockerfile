# Use an official Python runtime as a parent image
FROM python:3.9-slim

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libgl1-mesa-glx \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory
WORKDIR /usr/src/app

# Copy the requirements file and install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy application files
COPY main.py ./
COPY 8047000029a4000c61f808dd2fd54bb4.mp4 ./

# Default command
CMD ["python", "main.py"]
