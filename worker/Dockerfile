# syntax=docker/dockerfile:1.10
# Ollama Optivus AI - video analysis worker (FastAPI + faster-whisper + YOLO26 + EasyOCR).
#
# Build arguments:
#   TORCH_VARIANT   cu126 (default, NVIDIA driver >= 560) | cu129 (Blackwell / RTX 50xx, driver >= 575) | cpu
#   PRELOAD_MODELS  true (default) bakes all model weights into the image so the container runs fully offline
#   WHISPER_MODEL   faster-whisper model to preload (default large-v3-turbo)
#   OCR_LANGUAGES   EasyOCR languages to preload (default en,tr)
#   YOLO_MODEL      Ultralytics weights to preload (default yolo26n.pt)

ARG PYTHON_IMAGE=python:3.13-slim-trixie
ARG UV_IMAGE=ghcr.io/astral-sh/uv:0.13.6

FROM ${UV_IMAGE} AS uv

# ---------------------------------------------------------------------------
# deps: the locked Python environment (hash-verified by uv from uv.lock)
# ---------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS deps
ARG TORCH_VARIANT=cu126
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv
WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project --extra "${TORCH_VARIANT}"

# ---------------------------------------------------------------------------
# models: optional preload of every model the worker can use
# ---------------------------------------------------------------------------
FROM deps AS models
ARG PRELOAD_MODELS=true
ARG WHISPER_MODEL=large-v3-turbo
ARG OCR_LANGUAGES=en,tr
ARG YOLO_MODEL=yolo26n.pt
# Only the downloader: code changes elsewhere must not invalidate the (large) model layer.
COPY optivus_worker/__init__.py optivus_worker/download_models.py ./optivus_worker/
RUN mkdir -p /models && \
    if [ "${PRELOAD_MODELS}" = "true" ]; then \
      /opt/venv/bin/python -m optivus_worker.download_models \
        --models-dir /models \
        --whisper "${WHISPER_MODEL}" \
        --ocr-languages "${OCR_LANGUAGES}" \
        --yolo "${YOLO_MODEL}" \
        --faces ; \
    fi

# ---------------------------------------------------------------------------
# runtime: minimal image, non-root, no compilers, no package manager caches
# ---------------------------------------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime
ARG TORCH_VARIANT=cu126
LABEL org.opencontainers.image.title="optivus-worker" \
      org.opencontainers.image.description="Ollama Optivus AI video analysis worker" \
      org.opencontainers.image.source="https://github.com/TarikSeyceri/OllamaOptivus.ai" \
      org.opencontainers.image.licenses="MIT AND AGPL-3.0-only"

# libgomp1: OpenMP runtime used by CTranslate2/onnxruntime on CPU.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 optivus \
 && useradd --system --uid 10001 --gid optivus --no-create-home --home-dir /tmp --shell /usr/sbin/nologin optivus \
 # Shared data volume: a new named volume inherits this ownership (same UID as the API).
 && mkdir -p /data \
 && chown 10001:10001 /data

COPY --from=deps /opt/venv /opt/venv
COPY --from=models /models /models
COPY --chown=root:root optivus_worker /app/optivus_worker

# CTranslate2 (faster-whisper) loads cuBLAS/cuDNN for CUDA 12 from the pip-installed NVIDIA wheels.
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONUTF8=1 \
    LD_LIBRARY_PATH=/opt/venv/lib/python3.13/site-packages/nvidia/cublas/lib:/opt/venv/lib/python3.13/site-packages/nvidia/cudnn/lib \
    TORCH_VARIANT=${TORCH_VARIANT} \
    MODELS_DIR=/models \
    DATA_DIR=/data \
    HOME=/tmp \
    HF_HOME=/models/huggingface \
    HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    PROCESSING_ALLOW_DOWNLOADS=false \
    YOLO_OFFLINE=True \
    YOLO_AUTOINSTALL=False \
    YOLO_CONFIG_DIR=/tmp/ultralytics \
    MPLCONFIGDIR=/tmp/matplotlib \
    CUDA_CACHE_PATH=/tmp/cuda-cache \
    WORKER_HOST=0.0.0.0 \
    WORKER_PORT=8000

WORKDIR /app
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD ["python", "-c", "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status == 200 else 1)"]
CMD ["python", "-m", "optivus_worker"]
