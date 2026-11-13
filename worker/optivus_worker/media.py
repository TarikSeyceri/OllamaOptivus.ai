"""Video probing and frame sampling with PyAV (FFmpeg bundled in the wheel).

Frames are sampled by presentation timestamp, so the timing is exact for variable-frame-rate video
(phones, screen recordings) and never drifts against the speech timeline. Decoding is
multi-threaded, scaling happens inside FFmpeg, and the display-matrix rotation of phone videos is
applied so the models see upright images.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

from .errors import AnalysisError, Cancelled


@dataclass
class VideoInfo:
    duration: float
    width: int
    height: int
    fps: float | None
    has_audio: bool
    audio_streams: int
    video_codec: str | None

    def describe(self) -> dict:
        info = asdict(self)
        info["hasAudio"] = info.pop("has_audio")
        info["audioStreams"] = info.pop("audio_streams")
        info["videoCodec"] = info.pop("video_codec")
        info["duration"] = round(self.duration, 3)
        info["fps"] = round(self.fps, 3) if self.fps else None
        return info


def probe(path: Path) -> VideoInfo:
    import av

    try:
        container = av.open(str(path), metadata_errors="ignore")
    except Exception as error:  # av raises several FFmpeg error types for unreadable input
        raise AnalysisError("INVALID_VIDEO", "The file is not a readable video.") from error
    with container:
        video = next(iter(container.streams.video), None)
        if video is None:
            raise AnalysisError("NO_VIDEO_STREAM", "The file contains no video stream.")
        duration = 0.0
        if container.duration:
            duration = container.duration / 1_000_000
        elif video.duration and video.time_base:
            duration = float(video.duration * video.time_base)
        context = video.codec_context
        return VideoInfo(
            duration=duration,
            width=context.width,
            height=context.height,
            fps=float(video.average_rate) if video.average_rate else None,
            has_audio=len(container.streams.audio) > 0,
            audio_streams=len(container.streams.audio),
            video_codec=context.name,
        )


def _target_size(width: int, height: int, max_side: int) -> tuple[int, int]:
    scale = min(1.0, max_side / max(width, height))
    return max(2, round(width * scale / 2) * 2), max(2, round(height * scale / 2) * 2)


def sample_frames(
    path: Path,
    sample_fps: float,
    max_side: int,
    cancel: threading.Event | None = None,
) -> Iterator[tuple[float, np.ndarray]]:
    """Yields (seconds_from_start, BGR image) at most `sample_fps` times per second of video."""
    import av

    interval = 1.0 / sample_fps
    with av.open(str(path)) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        time_base = stream.time_base
        start = float(stream.start_time * time_base) if stream.start_time is not None else 0.0
        next_sample = 0.0
        size: tuple[int, int] | None = None
        for frame in container.decode(stream):
            if cancel is not None and cancel.is_set():
                raise Cancelled
            if frame.pts is None:
                continue
            t = max(0.0, float(frame.pts * time_base) - start)
            if t + 1e-6 < next_sample:
                continue
            while next_sample <= t + 1e-6:
                next_sample += interval
            if size is None:
                size = _target_size(frame.width, frame.height, max_side)
            scaled = size != (frame.width, frame.height)
            image = frame.to_ndarray(format="bgr24", width=size[0], height=size[1], interpolation="AREA" if scaled else None)
            turns = round((getattr(frame, "rotation", 0) or 0) / 90) % 4
            if turns:
                image = np.ascontiguousarray(np.rot90(image, turns))
            yield round(t, 3), image
