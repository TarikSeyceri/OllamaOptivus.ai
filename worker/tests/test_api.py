from __future__ import annotations

from conftest import analyze, make_settings, start_client


def test_health_auth_and_capabilities(client):
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/v1/capabilities", headers={"Authorization": "Bearer wrong-token-0123456789abcdef0123"}).status_code == 401
    caps = client.get("/v1/capabilities").json()
    assert caps["analysisVersion"] == 2
    assert {"objects", "ocr", "scenes", "faces"} <= set(caps["features"])
    assert "auto" in caps["languages"] and "tr" in caps["languages"]
    assert caps["models"]["speech"] == "fake:whisper"


def test_docs_are_disabled_in_production(client):
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_analyze_streams_progress_then_result(client, data_dir):
    events = analyze(client, features=["objects", "ocr", "scenes", "faces", "captions"], keyframes_dir="frames/key-1")
    assert events[0]["type"] == "progress"
    assert events[-1]["type"] == "result", events[-1]
    analysis = events[-1]["analysis"]

    assert analysis["analysisVersion"] == 2
    assert 13.5 < analysis["video"]["duration"] < 14.5
    assert analysis["video"]["hasAudio"] is True
    assert analysis["transcript"][0]["text"] == "Hello from the fake transcriber."

    times = [f["t"] for f in analysis["frames"]]
    assert len(times) == 14
    assert times == sorted(times) and times[0] == 0
    assert all(abs(t - round(t)) < 0.05 for t in times), "1 fps samples land on whole seconds"

    cuts = [f["t"] for f in analysis["frames"] if f.get("sceneCut")]
    assert cuts[0] == 0
    assert any(6.5 <= t <= 7.5 for t in cuts), f"hard cut at 7 s not detected: {cuts}"
    assert len(analysis["scenes"]) == len(cuts)

    keyframes = [f["keyframe"] for f in analysis["frames"] if f.get("keyframe")]
    assert len(keyframes) == len(cuts)
    for keyframe in keyframes:
        assert keyframe.startswith("frames/key-1/")
        assert (data_dir / keyframe).is_file()

    assert all(f["faces"][0]["expression"] == "neutral" for f in analysis["frames"])
    assert all(f["texts"] for f in analysis["frames"]), "every frame carries the last OCR result"


def test_ocr_is_skipped_on_unchanged_frames(client):
    analysis = analyze(client)[-1]["analysis"]
    calls = client.app.state.worker.registry.ocr.calls
    assert 0 < calls < len(analysis["frames"]), f"OCR ran {calls} times for {len(analysis['frames'])} frames"


def test_video_without_audio(client):
    analysis = analyze(client, path="silent.mp4")[-1]["analysis"]
    assert analysis["video"]["hasAudio"] is False
    assert analysis["transcript"] == []
    assert len(analysis["frames"]) == 5


def test_auto_language_reports_detection(client):
    analysis = analyze(client, language="auto")[-1]["analysis"]
    assert analysis["language"] == "auto"
    assert analysis["detectedLanguage"] == "en"


def test_busy_worker_answers_429(client):
    state = client.app.state.worker
    state.busy.acquire()
    try:
        response = client.post("/v1/analyze", json={"root": "videos", "path": "speech.mp4"})
        assert response.status_code == 429
        assert response.headers["retry-after"] == "5"
    finally:
        state.busy.release()


def test_path_problems_are_reported_as_error_events(client):
    cases = {
        "../secret.mp4": "PATH_NOT_ALLOWED",
        "/etc/passwd": "PATH_NOT_ALLOWED",
        "missing.mp4": "NOT_FOUND",
    }
    for path, code in cases.items():
        event = analyze(client, path=path)[-1]
        assert event == {"type": "error", "code": code, "message": event["message"]}, path
    assert analyze(client, root="nas")[-1]["code"] == "PATH_NOT_ALLOWED"
    bad_dir = analyze(client, features=["captions"], keyframes_dir="frames/../../etc")[-1]
    assert bad_dir["code"] == "PATH_NOT_ALLOWED"


def test_request_validation(client):
    assert client.post("/v1/analyze", json={"root": "videos", "path": "speech.mp4", "unknown": 1}).status_code == 422
    assert client.post("/v1/analyze", json={"root": "videos", "path": "speech.mp4", "sample_fps": 0}).status_code == 422
    assert analyze(client, language="xx")[-1]["code"] == "UNSUPPORTED_LANGUAGE"


def test_disabled_features_are_rejected(data_dir):
    client = start_client(make_settings(data_dir, processing_features="ocr,scenes"))
    try:
        assert set(client.get("/v1/capabilities").json()["features"]) == {"ocr", "scenes"}
        assert analyze(client, features=["faces"])[-1]["code"] == "FEATURE_UNAVAILABLE"
    finally:
        client.__exit__(None, None, None)


def test_configuration_problems(data_dir):
    assert any("WORKER_TOKEN" in p for p in make_settings(data_dir, worker_token=None).problems())
    assert any("too weak" in p for p in make_settings(data_dir, worker_token="mysecrettoken").problems())
    assert any("unknown feature" in p for p in make_settings(data_dir, processing_features="objects,emotions").problems())
    assert make_settings(data_dir, worker_token=None, worker_env="development").problems() == []
