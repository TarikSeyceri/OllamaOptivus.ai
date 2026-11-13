"""Request schema of POST /v1/analyze."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Feature = Literal["objects", "ocr", "scenes", "faces", "captions"]


class AnalyzeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    root: str = Field(pattern=r"^[a-z][a-z0-9_-]{1,31}$", description="Storage root name (same as the API's).")
    path: str = Field(min_length=1, max_length=1024, description="Video path relative to the root.")
    sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    language: str = Field(default="en", pattern=r"^(auto|[a-z]{2,3})$")
    sample_fps: float = Field(default=1.0, gt=0, le=30)
    features: list[Feature] = Field(default_factory=lambda: ["objects", "ocr", "scenes"], max_length=5)
    keyframes_dir: str | None = Field(default=None, max_length=210, description='Where to save keyframes, e.g. "frames/<key>".')
