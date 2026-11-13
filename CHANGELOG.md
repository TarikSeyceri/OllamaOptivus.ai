# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [2.0.0] - 2026-11-13

A rewrite for production use: GPU acceleration, an asynchronous job API, hardened security, Docker
Compose deployment and much faster processing. The v1 HTTP endpoints remain compatible; see the
[migration guide](docs/migration-v1-to-v2.md).

### Added

- **Worker service** (Python 3.13, FastAPI) that keeps models loaded on the GPU and streams progress.
  - PyAV decoding by timestamp; faster-whisper `large-v3-turbo`; YOLO26; EasyOCR on the GPU.
  - Speech and frame analysis run in parallel.
- **Asynchronous API** under `/v1`: content-addressed video uploads, jobs with long-polling, cancellation,
  deduplication, retries after restarts, and analysis and prompt retrieval. Also `/v1/models`,
  `/v1/capabilities`, `/health/live` and `/health/ready`.
- **Dev-branch features, re-implemented:**
  - scene-change detection, which also skips OCR on unchanged frames;
  - scene descriptions (keyframe captions by an Ollama vision model);
  - facial expressions (OpenCV Zoo YuNet + MobileFaceNet; opt-in).
- **Long videos:** a fixed context window with automatic map-reduce summarization. Generation stops as
  soon as the JSON answer is complete.
- **Multilingual:** every Whisper language plus `auto` detection; answers in the requested language.
- **Docker Compose stack:**
  - GPU by default, with CPU and host-Ollama variants;
  - a bundled Ollama tuned for 8 GB GPUs (flash attention, q8_0 KV cache);
  - init scripts that generate secrets.
- **Quality and tooling:**
  - an OpenAPI 3.1 document generated from the validation schemas, with Swagger UI;
  - 95 Node and 23 Python tests;
  - CI (lint, tests, OSV, `npm audit`, Docker smoke test, Trivy), CodeQL and Dependabot;
  - smoke and model-benchmark scripts;
  - full documentation in `docs/`.

### Changed

- The default language model is `qwen3.5:4b` (was `deepseek-r1`). The prompt now carries a task
  description, the JSON schema, the real video duration and a prompt-injection guard.
- `/process` runs as a queued job instead of failing with `503` while another video is processing.
- Node.js 26 LTS and Python 3.13 in Docker; Express 5, multer 2, pino logging and zod validation.
- Configuration is validated at start-up. `NODE_ENV` now defaults to `production`.

### Fixed

- A `ReferenceError` (`firstStartAudio`) whenever speech started after the first second.
- A non-string `videoFilePath` crashed the server.
- An infinite loop when a video's frame rate was 0 or lower than `PROCESSING_FPS`; frame timestamps
  drifted against the transcript on 29.97 fps video.
- Frames between speech segments were dropped; videos without speech produced empty prompts; all
  on-screen text was deleted in short videos.
- `videoExplanation` leaked between requests; different videos with the same file name shared cached
  results.
- Videos without an audio track, or with several, failed.
- Errors were logged as `{}`; upload errors returned HTML; long uploads and model pulls hit hidden 300 s
  timeouts.

### Security

- Strong API keys are mandatory (the published default token is rejected), compared in constant time,
  and can be rotated.
- Helmet headers, rate limits per key, and strict input schemas.
- Uploads are checked by content and written to temp files first; `PROCESSING_ONLY` is enforced before
  any write.
- Path containment uses realpath (blocks prefix look-alikes and symlinks) in both the API and the worker.
- A model allowlist; credentials and transcripts are redacted from logs.
- Non-root, read-only containers with all capabilities dropped; the worker has no internet access and
  Ollama is never published.
- Hash-verified lockfiles, a 14-day release-age policy, and actions pinned to commit SHAs.
- 13 npm vulnerabilities fixed (1 critical, 6 high), including multer CVE-2025-47935 and CVE-2025-7338.

### Removed

- The per-request Python script (`src/processor.py`), openai-whisper, ffmpeg-python, winston/morgan,
  node-schedule, nodemon, swagger-autogen, the development-only `/test` endpoint, and the committed
  `.env` and model weights.

## [1.0.0] - 2025-02-20

First public release: Express API, a Python script with YOLOv8, EasyOCR and Whisper, Ollama prompting,
Docker support.

[2.0.0]: https://github.com/TarikSeyceri/OllamaOptivus.ai/compare/v1.0...v2.0.0
[1.0.0]: https://github.com/TarikSeyceri/OllamaOptivus.ai/releases/tag/v1.0
