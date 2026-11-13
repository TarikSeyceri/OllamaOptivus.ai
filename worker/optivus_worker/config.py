"""Worker configuration from environment variables (documented in docs/configuration.md)."""

from __future__ import annotations

from functools import cached_property
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

ALL_FEATURES = ("objects", "ocr", "scenes", "faces")
WEAK_TOKENS = {"mysecrettoken", "changeme", "secret", "token", "password", "test", "admin"}
MIN_TOKEN_LENGTH = 32


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore", case_sensitive=False)

    # Service
    worker_env: Literal["production", "development"] = "production"
    worker_host: str = "127.0.0.1"
    worker_port: int = Field(8000, ge=1, le=65535)
    worker_token: str | None = None
    worker_token_file: Path | None = None
    log_level: Literal["CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"] = "INFO"

    # Storage (must match the API: same volume, same root names)
    data_dir: Path = Path("data")
    models_dir: Path = Path("models")
    # Docker images bake every model in and set this to false (the worker then needs no internet).
    processing_allow_downloads: bool = True
    processing_roots: str = ""
    allow_process_videos_outside_videos_dir: bool = False

    # Hardware and limits
    processing_device: Literal["auto", "cuda", "cpu", "mps"] = "auto"
    processing_features: str = "objects,ocr,scenes"
    processing_max_video_seconds: float = Field(4 * 3600, gt=0)
    processing_max_sample_fps: float = Field(5.0, gt=0, le=30)
    processing_frame_max_side: int = Field(1280, ge=320, le=4096)
    processing_release_vram: bool = True

    # Speech-to-text (faster-whisper)
    processing_whisper_model: str = "large-v3-turbo"
    processing_whisper_compute_type: str = "auto"
    processing_whisper_batch_size: int = Field(8, ge=1, le=64)
    processing_whisper_beam_size: int = Field(1, ge=1, le=10)

    # Objects (Ultralytics YOLO)
    processing_yolo_model: str = "yolo26n.pt"
    processing_yolo_confidence: float = Field(0.45, gt=0, lt=1)
    processing_yolo_batch_size: int = Field(8, ge=1, le=64)

    # On-screen text (EasyOCR)
    processing_ocr_languages: str = "en,tr"
    processing_ocr_min_confidence: float = Field(0.4, ge=0, le=1)
    processing_ocr_canvas_size: int = Field(1280, ge=320, le=4096)
    processing_ocr_min_interval_seconds: float = Field(2.0, ge=0)

    # Scenes and keyframes
    processing_scene_cut_threshold: float = Field(0.7, gt=0, lt=1)
    processing_frame_change_ratio: float = Field(0.01, gt=0, lt=1)
    processing_keyframe_max_side: int = Field(768, ge=224, le=2048)
    processing_max_keyframes: int = Field(60, ge=1, le=1000)
    processing_keyframe_min_interval_seconds: float = Field(10.0, ge=0)

    # Tests: replace every ML model with a deterministic fake (no torch/GPU needed).
    optivus_fake_models: bool = False

    @property
    def is_development(self) -> bool:
        return self.worker_env == "development"

    @cached_property
    def features(self) -> frozenset[str]:
        return frozenset(f.strip().lower() for f in self.processing_features.split(",") if f.strip())

    @cached_property
    def ocr_languages(self) -> tuple[str, ...]:
        return tuple(lang.strip().lower() for lang in self.processing_ocr_languages.split(",") if lang.strip())

    def tokens(self) -> list[str]:
        values = [self.worker_token or ""]
        if self.worker_token_file:
            values.append(self.worker_token_file.read_text(encoding="utf-8"))
        return [t.strip() for t in ",".join(values).replace("\r", "\n").replace("\n", ",").split(",") if t.strip()]

    def roots(self) -> dict[str, Path]:
        """Named storage roots. Names and directories must match the API's PROCESSING_ROOTS."""
        roots = {"videos": self.data_dir / "videos"}
        for entry in filter(None, (e.strip() for e in self.processing_roots.split(","))):
            name, _, directory = entry.partition(":")
            roots[name.strip().lower()] = Path(directory.strip())
        if self.allow_process_videos_outside_videos_dir:
            roots["filesystem"] = Path(self.data_dir.resolve().anchor)
        return roots

    def problems(self) -> list[str]:
        """Configuration errors that must stop the worker from starting."""
        problems = []
        unknown = self.features - set(ALL_FEATURES)
        if unknown:
            problems.append(f"PROCESSING_FEATURES: unknown feature(s) {sorted(unknown)}; use {', '.join(ALL_FEATURES)}")
        for entry in filter(None, (e.strip() for e in self.processing_roots.split(","))):
            name, sep, directory = entry.partition(":")
            if not sep or len(name.strip()) < 2 or not directory.strip():
                problems.append(f'PROCESSING_ROOTS: expected "name:/absolute/dir", got "{entry}"')
        try:
            tokens = self.tokens()
        except OSError as error:
            return [*problems, f"WORKER_TOKEN_FILE: {error}"]
        if not tokens and not self.is_development:
            problems.append("WORKER_TOKEN (or WORKER_TOKEN_FILE) is required in production.")
        for i, token in enumerate(tokens, 1):
            if token.lower() in WEAK_TOKENS or len(token) < MIN_TOKEN_LENGTH:
                problems.append(f"WORKER_TOKEN #{i} is too weak; use at least {MIN_TOKEN_LENGTH} random characters.")
        return problems
