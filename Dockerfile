FROM python:3.11.9-slim

# Install Node.js 18.x
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && \
    apt-get install -y nodejs=18.20.5-1nodesource1

# Install system dependencies for Python packages
RUN apt-get install -y \
    ffmpeg \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev

WORKDIR /app

COPY . .

RUN npm install
RUN pip install --no-cache-dir -r requirements.txt

CMD ["npm", "run", "node"]