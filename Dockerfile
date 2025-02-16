FROM python:3.11.9-slim

# Install Node.js 18.x
RUN apt-get update && apt-get install -y curl=7.88.1-10+deb12u8 && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs=18.20.5-1nodesource1

# Install system dependencies for Python packages
RUN apt-get install -y \
    ffmpeg=7:5.1.6-0+deb12u1 \
    libgl1-mesa-glx=22.3.6-1+deb12u1 \
    libglib2.0-0=2.74.6-2+deb12u5 

# Clean up
RUN apt-get clean && rm -rf /var/lib/apt/lists

WORKDIR /app

COPY requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt
