"""One analysis: probe -> (speech || frames) -> analysis document (version 2).

Speech recognition and frame analysis run in parallel threads (CTranslate2, PyTorch and FFmpeg all
release the GIL). Frame decoding runs in its own producer thread so the CPU decodes the next batch
while the GPU analyzes the current one. Expensive steps are gated:
  - OCR runs on scene cuts, or on frames that changed visibly since the last read (at most every
    PROCESSING_OCR_MIN_INTERVAL_SECONDS); otherwise the previous text is reused.
  - Facial expressions are analyzed only where the object detector saw a person.
  - Keyframes for scene descriptions are saved only at scene cuts.
"""

from __future__ import annotations

import itertools
import logging
import math
import queue
import threading
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

from . import ANALYSIS_VERSION
from .config import Settings
from .errors import AnalysisError, Cancelled
from .languages import WHISPER_LANGUAGES
from .media import VideoInfo, probe, sample_frames
from .scenes import SceneDetector, changed
from .schemas import AnalyzeRequest
from .security import resolve_keyframes_dir, resolve_video

log = logging.getLogger(__name__)
_END = object()
Emit = Callable[[dict], None]


class Progress:
    """Combines speech (35%) and frame (65%) progress; emits at most twice a second."""

    def __init__(self, emit: Emit, has_audio: bool) -> None:
        self.emit = emit
        self.parts = {"speech": 0.0 if has_audio else 1.0, "frames": 0.0}
        self.last_emit = 0.0
        self.lock = threading.Lock()

    def update(self, part: str, value: float) -> None:
        with self.lock:
            self.parts[part] = max(self.parts[part], min(1.0, value))
            now = time.monotonic()
            if now - self.last_emit < 0.5 and value < 1.0:
                return
            self.last_emit = now
            total = 0.35 * self.parts["speech"] + 0.65 * self.parts["frames"]
        self.emit({"type": "progress", "stage": part, "progress": round(total, 3)})


def save_keyframe(image: np.ndarray, directory: Path, t: float, max_side: int) -> str:
    height, width = image.shape[:2]
    scale = min(1.0, max_side / max(height, width))
    if scale < 1.0:
        image = cv2.resize(image, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv2.INTER_AREA)
    ok, buffer = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise AnalysisError("INTERNAL", "Could not encode a keyframe.")
    directory.mkdir(parents=True, exist_ok=True)
    name = f"{round(t * 1000):09d}.jpg"
    tmp = directory / f".{name}.tmp"
    tmp.write_bytes(buffer.tobytes())
    tmp.replace(directory / name)
    return name


def analyze(settings: Settings, registry, request: AnalyzeRequest, emit: Emit, cancel: threading.Event) -> dict:
    started = time.monotonic()
    path = resolve_video(settings.roots(), request.root, request.path)
    info = probe(path)
    if info.duration > settings.processing_max_video_seconds:
        raise AnalysisError(
            "VIDEO_TOO_LONG",
            f"The video is {info.duration / 60:.0f} min long; the limit is {settings.processing_max_video_seconds / 60:.0f} min.",
        )
    if request.language != "auto" and request.language not in WHISPER_LANGUAGES:
        raise AnalysisError("UNSUPPORTED_LANGUAGE", f'Speech recognition does not support "{request.language}".')
    requested = set(request.features)
    unavailable = (requested - {"captions"}) - registry.available_features
    if unavailable:
        raise AnalysisError("FEATURE_UNAVAILABLE", f"Not enabled on this worker: {', '.join(sorted(unavailable))}.")
    keyframes_dir = resolve_keyframes_dir(settings.data_dir, request.keyframes_dir) if "captions" in requested else None
    sample_fps = min(request.sample_fps, settings.processing_max_sample_fps)

    progress = Progress(emit, info.has_audio)
    emit({"type": "progress", "stage": "starting", "progress": 0})
    registry.prepare()
    try:
        with ThreadPoolExecutor(max_workers=2, thread_name_prefix="analysis") as pool:
            speech = pool.submit(_speech, registry, path, request.language, info, cancel, progress) if info.has_audio else None
            frames_job = pool.submit(
                _frames, settings, registry, path, request, requested, keyframes_dir, sample_fps, info, cancel, progress
            )
            try:
                frames, scenes, frames_ms = frames_job.result()
                transcript, detected, speech_ms = speech.result() if speech else ([], None, 0)
            except BaseException:
                cancel.set()  # stop the other half quickly
                raise
    except Exception as error:
        if type(error).__name__ == "OutOfMemoryError" or "out of memory" in str(error).lower():
            raise AnalysisError("OUT_OF_GPU_MEMORY", "The GPU ran out of memory (see docs/performance.md).") from error
        raise
    finally:
        registry.release_vram()

    return {
        "analysisVersion": ANALYSIS_VERSION,
        "video": info.describe(),
        "language": request.language,
        "detectedLanguage": detected,
        "sampleFps": sample_fps,
        "transcript": transcript,
        "frames": frames,
        "scenes": scenes,
        "timings": {"speechMs": speech_ms, "framesMs": frames_ms, "totalMs": round((time.monotonic() - started) * 1000)},
        "models": registry.describe(),
        "device": registry.device.torch_device,
    }


def _speech(registry, path: Path, language: str, info: VideoInfo, cancel: threading.Event, progress: Progress):
    started = time.monotonic()
    transcript, detected = registry.transcriber.transcribe(
        path, language, info.duration, cancel, lambda p: progress.update("speech", p)
    )
    progress.update("speech", 1.0)
    return transcript, detected, round((time.monotonic() - started) * 1000)


def _frames(
    settings: Settings,
    registry,
    path: Path,
    request: AnalyzeRequest,
    requested: set[str],
    keyframes_dir: Path | None,
    sample_fps: float,
    info: VideoInfo,
    cancel: threading.Event,
    progress: Progress,
):
    started = time.monotonic()
    batches: queue.Queue = queue.Queue(maxsize=4)

    def put(item) -> None:
        while not cancel.is_set():
            try:
                batches.put(item, timeout=0.5)
                return
            except queue.Full:
                continue

    def produce() -> None:
        try:
            batch = []
            for item in sample_frames(path, sample_fps, settings.processing_frame_max_side, cancel):
                batch.append(item)
                if len(batch) >= settings.processing_yolo_batch_size:
                    put(batch)
                    batch = []
            if batch:
                put(batch)
            put(_END)
        except BaseException as error:  # forwarded to the consumer
            put(error)

    producer = threading.Thread(target=produce, name="decode", daemon=True)
    producer.start()

    objects = registry.objects if "objects" in requested else None
    ocr = registry.ocr if "ocr" in requested else None
    faces = registry.faces if "faces" in requested else None
    ocr_languages = ocr.languages_for(request.language) if ocr is not None else ()
    scenes_out = "scenes" in requested
    detector = SceneDetector(settings.processing_scene_cut_threshold)

    frames: list[dict] = []
    cuts: list[float] = []
    last_ocr_t, last_ocr_gray, last_texts = -math.inf, None, []
    last_keyframe_t, keyframes = -math.inf, 0

    while True:
        try:
            item = batches.get(timeout=0.5)
        except queue.Empty:
            if cancel.is_set():
                raise Cancelled from None
            continue
        if item is _END:
            break
        if isinstance(item, BaseException):
            raise item
        if cancel.is_set():
            raise Cancelled

        detections = objects.detect([image for _, image in item]) if objects is not None else [{} for _ in item]
        for (t, image), found in zip(item, detections, strict=True):
            entry: dict = {"t": round(t, 2), "objects": found, "texts": []}
            cut, gray = detector.observe(image)
            if cut:
                cuts.append(t)
                if scenes_out:
                    entry["sceneCut"] = True
            if ocr is not None:
                due = t - last_ocr_t >= settings.processing_ocr_min_interval_seconds
                if cut or (due and changed(last_ocr_gray, gray, settings.processing_frame_change_ratio)):
                    last_texts, last_ocr_t, last_ocr_gray = ocr.read(image, ocr_languages), t, gray
                entry["texts"] = list(last_texts)
            if faces is not None and (objects is None or found.get("person")):
                entry["faces"] = faces.analyze(image)
            if (
                keyframes_dir is not None
                and cut
                and keyframes < settings.processing_max_keyframes
                and t - last_keyframe_t >= settings.processing_keyframe_min_interval_seconds
            ):
                name = save_keyframe(image, keyframes_dir, t, settings.processing_keyframe_max_side)
                entry["keyframe"] = f"{request.keyframes_dir}/{name}"
                keyframes += 1
                last_keyframe_t = t
            frames.append(entry)
        if info.duration > 0:
            progress.update("frames", item[-1][0] / info.duration)

    producer.join(timeout=5)
    progress.update("frames", 1.0)
    duration = max(info.duration, frames[-1]["t"] if frames else 0.0)
    scenes = []
    if scenes_out and cuts:
        bounds = [*cuts, duration]
        scenes = [{"start": round(a, 2), "end": round(b, 2)} for a, b in itertools.pairwise(bounds) if b > a]
    return frames, scenes, round((time.monotonic() - started) * 1000)
