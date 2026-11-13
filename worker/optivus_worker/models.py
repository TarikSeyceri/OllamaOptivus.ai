"""Loads every model once at start-up, keeps them warm, and manages GPU memory between jobs."""

from __future__ import annotations

import logging

import numpy as np

from .config import Settings
from .device import Device, release_cached_memory, wait_for_gpu_memory

log = logging.getLogger(__name__)

# VRAM the worker wants free before a job: Whisper turbo int8 (~0.8 GB) + activations + OCR/YOLO.
JOB_VRAM_BYTES = int(1.5 * 1024**3)


class ModelRegistry:
    def __init__(self, settings: Settings, device: Device) -> None:
        self.settings = settings
        self.device = device
        self.transcriber = None
        self.objects = None
        self.ocr = None
        self.faces = None

    def load(self) -> None:
        # Import torch before CTranslate2: on Windows this puts torch's bundled CUDA/cuDNN DLLs on the
        # search path that faster-whisper needs.
        import torch  # noqa: F401

        from .transcribe import Transcriber

        features = self.settings.features
        log.info("Loading models on %s (%s)", self.device.torch_device, self.device.name)
        self.transcriber = Transcriber(self.settings, self.device)
        if "objects" in features:
            from .objects import ObjectDetector

            self.objects = ObjectDetector(self.settings, self.device)
            self.objects.detect([np.zeros((360, 640, 3), dtype=np.uint8)])  # warm-up: builds the CUDA kernels
        if "ocr" in features:
            from .ocr import TextReader

            self.ocr = TextReader(self.settings, self.device)
            self.ocr.warm_up()
        if "faces" in features:
            from .faces import FaceExpressionAnalyzer

            self.faces = FaceExpressionAnalyzer(self.settings.models_dir)
        self.release_vram()  # idle state: leave the GPU to the language model
        log.info("Models ready: %s", self.describe())

    @property
    def available_features(self) -> set[str]:
        available = {"scenes"} & self.settings.features
        for feature, component in (("objects", self.objects), ("ocr", self.ocr), ("faces", self.faces)):
            if component is not None:
                available.add(feature)
        return available

    def prepare(self) -> None:
        """Before a job: wait for the language model to leave the GPU, then reload Whisper (~1 s)."""
        if self.device.kind == "cuda":
            wait_for_gpu_memory(self.device, JOB_VRAM_BYTES)
        self.transcriber.ensure_loaded()

    def release_vram(self) -> None:
        """After a job: free GPU memory so a language model on the same GPU fits."""
        if self.settings.processing_release_vram and self.transcriber is not None:
            self.transcriber.unload()
            release_cached_memory(self.device)

    def describe(self) -> dict:
        return {
            "speech": getattr(self.transcriber, "id", None),
            "objects": getattr(self.objects, "id", None),
            "ocr": getattr(self.ocr, "id", None),
            "faces": getattr(self.faces, "id", None),
        }
