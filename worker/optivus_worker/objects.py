"""Object detection with Ultralytics YOLO26 (batched; FP16 on CUDA).

Licence note: Ultralytics is AGPL-3.0. This feature can be switched off
(PROCESSING_FEATURES without "objects"); the package is then never imported.
"""

from __future__ import annotations

import os
from collections import Counter

import numpy as np

from .config import Settings
from .device import Device


def configure_ultralytics(settings: Settings) -> None:
    """Quiet, offline-friendly Ultralytics: no console banners, no telemetry, no auto-installs."""
    os.environ.setdefault("YOLO_VERBOSE", "False")
    os.environ.setdefault("YOLO_AUTOINSTALL", "False")
    if not settings.processing_allow_downloads:
        os.environ.setdefault("YOLO_OFFLINE", "True")
    from ultralytics import settings as ultralytics_settings

    ultralytics_settings.update({"sync": False})


class ObjectDetector:
    def __init__(self, settings: Settings, device: Device) -> None:
        configure_ultralytics(settings)
        from ultralytics import YOLO

        weights = settings.models_dir / settings.processing_yolo_model
        self.model = YOLO(str(weights) if weights.exists() else settings.processing_yolo_model)
        self.names = self.model.names
        self.confidence = settings.processing_yolo_confidence
        self.device = device.torch_device
        self.quantize = 16 if device.kind == "cuda" else None  # FP16 on NVIDIA, FP32 elsewhere
        self.id = f"ultralytics:{weights.name}"

    def detect(self, images: list[np.ndarray]) -> list[dict[str, int]]:
        """Per image: {label: count} of detections above the confidence threshold."""
        results = self.model.predict(
            images,
            conf=self.confidence,
            device=self.device,
            quantize=self.quantize,
            imgsz=640,
            max_det=100,
            verbose=False,
        )
        return [dict(Counter(self.names[int(c)] for c in r.boxes.cls.tolist())) for r in results]
