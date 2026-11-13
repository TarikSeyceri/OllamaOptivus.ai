"""Speech-to-text with faster-whisper (CTranslate2): about 4x faster than openai-whisper at the
same accuracy, int8/float16 kernels, voice-activity detection and batched decoding."""

from __future__ import annotations

import threading
from collections.abc import Callable
from pathlib import Path

from .config import Settings
from .device import Device
from .errors import AnalysisError, Cancelled


class Transcriber:
    def __init__(self, settings: Settings, device: Device) -> None:
        from faster_whisper import BatchedInferencePipeline, WhisperModel

        name = settings.processing_whisper_model
        local = settings.models_dir / "whisper" / name
        source = str(local) if (local / "model.bin").exists() else name
        compute = settings.processing_whisper_compute_type
        if compute == "auto":
            compute = "int8_float16" if device.kind == "cuda" else "int8"
        self.model = WhisperModel(
            source,
            device="cuda" if device.kind == "cuda" else "cpu",  # CTranslate2 has no stable MPS backend
            device_index=device.index if device.kind == "cuda" else 0,
            compute_type=compute,
            download_root=str(settings.models_dir / "whisper"),
            local_files_only=not settings.processing_allow_downloads,
        )
        self.pipeline = BatchedInferencePipeline(model=self.model)
        self.batch_size = settings.processing_whisper_batch_size
        self.beam_size = settings.processing_whisper_beam_size
        self.on_gpu = device.kind == "cuda"
        self.id = f"faster-whisper:{name}/{compute}"

    def unload(self) -> None:
        """Moves the weights to system RAM so the GPU is free for the language model (~1 s to reload)."""
        if self.on_gpu and self.model.model.model_is_loaded:
            self.model.model.unload_model(to_cpu=True)

    def ensure_loaded(self) -> None:
        if not self.model.model.model_is_loaded:
            self.model.model.load_model()

    def transcribe(
        self,
        path: Path,
        language: str,
        duration: float,
        cancel: threading.Event,
        on_progress: Callable[[float], None],
    ) -> tuple[list[dict], str | None]:
        try:
            segments, info = self.pipeline.transcribe(
                str(path),
                language=None if language == "auto" else language,
                batch_size=self.batch_size,
                beam_size=self.beam_size,
                vad_filter=True,
                without_timestamps=False,  # sentence-level segments instead of one per 30 s chunk
                word_timestamps=False,
                log_progress=False,
            )
        except ValueError as error:
            raise AnalysisError("UNSUPPORTED_LANGUAGE", f"Speech recognition does not support '{language}'.") from error

        result: list[dict] = []
        for segment in segments:
            if cancel.is_set():
                raise Cancelled
            text = segment.text.strip()
            # Whisper sometimes "hears" words in noise or silence; such segments have a high
            # no-speech probability and a low average log-probability.
            if not text or (segment.no_speech_prob > 0.6 and segment.avg_logprob < -1.0):
                continue
            result.append({"start": round(segment.start, 2), "end": round(segment.end, 2), "text": text})
            if duration > 0:
                on_progress(min(1.0, segment.end / duration))
        return result, info.language
