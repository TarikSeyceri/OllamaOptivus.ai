"""On-screen text with EasyOCR (GPU when available).

Readers are cached per language set (at most two at a time: each holds ~100-300 MB). Only the
languages baked into the image (PROCESSING_OCR_LANGUAGES) are used, so the worker never downloads
at run time; other request languages fall back to English OCR.
"""

from __future__ import annotations

import logging
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path

import numpy as np

from .config import Settings
from .device import Device

log = logging.getLogger(__name__)


class TextReader:
    def __init__(self, settings: Settings, device: Device) -> None:
        import easyocr

        self._easyocr = easyocr
        self.settings = settings
        self.gpu: bool | str = device.torch_device if device.kind in ("cuda", "mps") else False
        self.quantize = device.kind == "cpu"
        self.readers: OrderedDict[tuple[str, ...], object] = OrderedDict()
        self.lock = threading.Lock()
        self.id = f"easyocr:{easyocr.__version__}"

    def languages_for(self, language: str) -> tuple[str, ...]:
        baked = self.settings.ocr_languages
        if language == "auto":
            return tuple(sorted(baked, key=lambda lang: lang == "en"))  # e.g. ("tr", "en")
        if language in baked:
            return (language, "en") if language != "en" and "en" in baked else (language,)
        return ("en",) if "en" in baked else baked[:1]

    def _reader(self, languages: tuple[str, ...]):
        with self.lock:
            if languages in self.readers:
                self.readers.move_to_end(languages)
                return self.readers[languages]
            reader = self._easyocr.Reader(
                list(languages),
                gpu=self.gpu,
                model_storage_directory=str(self.settings.models_dir / "easyocr"),
                # Only used for custom networks (none here), but EasyOCR creates it: keep it on tmpfs
                # because the models directory is read-only in the container.
                user_network_directory=str(Path(tempfile.gettempdir()) / "easyocr-user-networks"),
                download_enabled=self.settings.processing_allow_downloads,
                quantize=self.quantize,
                verbose=False,
            )
            self.readers[languages] = reader
            while len(self.readers) > 2:
                self.readers.popitem(last=False)
            return reader

    def warm_up(self) -> None:
        # Preload the readers requests will use (English and the combined baked set), so the first
        # job does not pay ~2-3 s of model loading.
        for language in dict.fromkeys(("en", "auto")):
            self._reader(self.languages_for(language))

    def read(self, image: np.ndarray, languages: tuple[str, ...]) -> list[str]:
        results = self._reader(languages).readtext(
            image,
            decoder="greedy",
            batch_size=8,
            paragraph=False,
            canvas_size=self.settings.processing_ocr_canvas_size,
        )
        texts: list[str] = []
        seen: set[str] = set()
        for _box, text, confidence in results:
            clean = " ".join(str(text).split())
            if clean and confidence >= self.settings.processing_ocr_min_confidence and clean.lower() not in seen:
                seen.add(clean.lower())
                texts.append(clean)
        return texts
