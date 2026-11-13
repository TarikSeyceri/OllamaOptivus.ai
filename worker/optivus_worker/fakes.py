"""Deterministic stand-ins for the ML models (OPTIVUS_FAKE_MODELS=1).

Used by the unit tests and CI: video decoding, sampling, scene detection, keyframes, the HTTP API
and the NDJSON protocol all run for real; only the neural networks are replaced.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path

import numpy as np

from .config import Settings
from .device import Device


class FakeTranscriber:
    id = "fake:whisper"

    def transcribe(
        self,
        path: Path,
        language: str,
        duration: float,
        cancel: threading.Event,
        on_progress: Callable[[float], None],
    ) -> tuple[list[dict], str | None]:
        on_progress(1.0)
        end = round(min(duration, 5.0), 2) if duration else 5.0
        return [{"start": 1.5, "end": end, "text": "Hello from the fake transcriber."}], (
            "en" if language == "auto" else language
        )

    def unload(self) -> None: ...

    def ensure_loaded(self) -> None: ...


class FakeObjects:
    id = "fake:yolo"

    def detect(self, images: list[np.ndarray]) -> list[dict[str, int]]:
        return [{"person": 1} for _ in images]


class FakeOcr:
    id = "fake:ocr"

    def __init__(self) -> None:
        self.calls = 0

    def languages_for(self, language: str) -> tuple[str, ...]:
        return ("en",)

    def warm_up(self) -> None: ...

    def read(self, image: np.ndarray, languages: tuple[str, ...]) -> list[str]:
        self.calls += 1
        return [f"FAKE TEXT {int(image.mean()) // 32}"]  # changes when the picture changes a lot


class FakeFaces:
    id = "fake:faces"

    def analyze(self, image: np.ndarray) -> list[dict]:
        return [{"expression": "neutral", "score": 0.9}]


class FakeRegistry:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.device = Device("cpu", "fake")
        self.transcriber = FakeTranscriber()
        features = settings.features
        self.objects = FakeObjects() if "objects" in features else None
        self.ocr = FakeOcr() if "ocr" in features else None
        self.faces = FakeFaces() if "faces" in features else None

    def load(self) -> None: ...

    @property
    def available_features(self) -> set[str]:
        available = {"scenes"} & self.settings.features
        for feature, component in (("objects", self.objects), ("ocr", self.ocr), ("faces", self.faces)):
            if component is not None:
                available.add(feature)
        return available

    def prepare(self) -> None: ...

    def release_vram(self) -> None: ...

    def describe(self) -> dict:
        return {"speech": FakeTranscriber.id, "objects": FakeObjects.id, "ocr": FakeOcr.id, "faces": FakeFaces.id}
