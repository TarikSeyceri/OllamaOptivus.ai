from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from optivus_worker.config import Settings
from optivus_worker.main import create_app

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "test" / "fixtures"
TOKEN = "worker-test-token-0123456789abcdef012345"


@pytest.fixture
def data_dir(tmp_path: Path) -> Path:
    videos = tmp_path / "videos"
    videos.mkdir()
    for name in ("speech.mp4", "silent.mp4", "rotated.mp4"):
        shutil.copy(FIXTURES / name, videos / name)
    return tmp_path


def make_settings(data_dir: Path, **overrides) -> Settings:
    values = {
        "worker_env": "production",
        "worker_token": TOKEN,
        "data_dir": data_dir,
        "models_dir": data_dir / "models",
        "optivus_fake_models": True,
        "processing_features": "objects,ocr,scenes,faces",
        "processing_keyframe_min_interval_seconds": 0,
    }
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def settings(data_dir: Path) -> Settings:
    return make_settings(data_dir)


def start_client(settings: Settings):
    client = TestClient(create_app(settings))
    client.__enter__()
    deadline = time.time() + 15
    while client.get("/readyz").status_code != 200:
        assert time.time() < deadline, client.get("/readyz").json()
        time.sleep(0.05)
    client.headers["Authorization"] = f"Bearer {TOKEN}"
    return client


@pytest.fixture
def client(settings: Settings):
    client = start_client(settings)
    yield client
    client.__exit__(None, None, None)


def analyze(client: TestClient, **body) -> list[dict]:
    payload = {"root": "videos", "path": "speech.mp4", "language": "en", "sample_fps": 1.0, **body}
    with client.stream("POST", "/v1/analyze", json=payload) as response:
        assert response.status_code == 200, response.read()
        return [json.loads(line) for line in response.iter_lines() if line]
