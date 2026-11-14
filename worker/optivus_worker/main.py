"""HTTP API of the worker. It is meant for the internal Docker network only (the API calls it).

GET  /healthz          liveness (always 200 while the process runs)
GET  /readyz           200 once the models are loaded, 503 while loading or after a failure
GET  /v1/capabilities  languages, features, model ids, device and limits        (bearer token)
POST /v1/analyze       analyze one video; NDJSON stream of progress/heartbeat/result|error
                       events. One analysis at a time per worker (429 when busy). Closing the
                       connection cancels the analysis.                       (bearer token)
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse

from . import ANALYSIS_VERSION, __version__
from .config import Settings
from .errors import AnalysisError, Cancelled
from .languages import WHISPER_LANGUAGES
from .pipeline import analyze
from .schemas import AnalyzeRequest
from .security import bearer_auth

log = logging.getLogger("optivus_worker")
HEARTBEAT_SECONDS = 10


class WorkerState:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.registry = None
        self.status = "starting"
        self.error: str | None = None
        self.busy = threading.Lock()

    @property
    def ready(self) -> bool:
        return self.status == "ready"

    def load(self) -> None:
        self.status = "loading"
        try:
            if self.settings.optivus_fake_models:
                from .fakes import FakeRegistry

                registry = FakeRegistry(self.settings)
            else:
                from .device import select_device
                from .models import ModelRegistry

                registry = ModelRegistry(self.settings, select_device(self.settings.processing_device))
            registry.load()
            self.registry = registry
            self.status = "ready"
        except Exception as error:
            log.exception("Loading the models failed")
            self.error = f"{type(error).__name__}: {error}"
            self.status = "error"

    def capabilities(self) -> dict:
        settings, registry = self.settings, self.registry
        return {
            "analysisVersion": ANALYSIS_VERSION,
            "workerVersion": __version__,
            "languages": ["auto", *sorted(WHISPER_LANGUAGES)],
            "ocrLanguages": list(settings.ocr_languages),
            "features": sorted(registry.available_features),
            "keyframes": True,
            "models": registry.describe(),
            "device": registry.device.describe(),
            "limits": {
                "maxVideoSeconds": settings.processing_max_video_seconds,
                "maxSampleFps": settings.processing_max_sample_fps,
            },
        }


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    state = WorkerState(settings)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        # Load in the background: /healthz answers immediately, /readyz reports "loading".
        threading.Thread(target=state.load, name="model-loader", daemon=True).start()
        yield

    docs = settings.is_development
    app = FastAPI(
        title="Ollama Optivus AI worker",
        version=__version__,
        lifespan=lifespan,
        docs_url="/docs" if docs else None,
        redoc_url=None,
        openapi_url="/openapi.json" if docs else None,
    )
    app.state.worker = state
    auth = bearer_auth(settings.tokens())

    @app.get("/healthz")
    def healthz() -> dict:
        return {"status": "ok"}

    @app.get("/readyz")
    def readyz():
        if state.ready:
            return {"status": "ready", "busy": state.busy.locked()}
        return JSONResponse(status_code=503, content={"status": state.status, "error": state.error})

    @app.get("/v1/capabilities", dependencies=[Depends(auth)])
    def capabilities() -> dict:
        if not state.ready:
            raise HTTPException(status_code=503, detail=f"The models are {state.status}.", headers={"Retry-After": "5"})
        return state.capabilities()

    @app.post("/v1/analyze", dependencies=[Depends(auth)])
    async def analyze_video(body: AnalyzeRequest):
        if not state.ready:
            raise HTTPException(status_code=503, detail=f"The models are {state.status}.", headers={"Retry-After": "5"})
        if not state.busy.acquire(blocking=False):
            raise HTTPException(status_code=429, detail="The worker is busy with another video.", headers={"Retry-After": "5"})

        loop = asyncio.get_running_loop()
        events: asyncio.Queue = asyncio.Queue()
        cancel = threading.Event()

        def emit(event: dict | None) -> None:
            try:
                loop.call_soon_threadsafe(events.put_nowait, event)
            except RuntimeError:  # event loop already closed (shutdown)
                cancel.set()

        def run() -> None:
            try:
                emit({"type": "result", "analysis": analyze(settings, state.registry, body, emit, cancel)})
            except Cancelled:
                log.info("Analysis cancelled by the client")
            except AnalysisError as error:
                emit({"type": "error", "code": error.code, "message": error.message})
            except Exception:
                log.exception("Analysis failed")
                emit({"type": "error", "code": "INTERNAL", "message": "The analysis failed unexpectedly."})
            finally:
                state.busy.release()
                emit(None)

        threading.Thread(target=run, name="analysis", daemon=True).start()

        async def stream():
            try:
                while True:
                    try:
                        event = await asyncio.wait_for(events.get(), timeout=HEARTBEAT_SECONDS)
                    except TimeoutError:
                        yield b'{"type":"heartbeat"}\n'
                        continue
                    if event is None:
                        return
                    yield (json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
            finally:
                cancel.set()  # the client went away (or we are done): stop the analysis

        return StreamingResponse(
            stream(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    return app
