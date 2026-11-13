# Migrating from v1 to v2

v2 keeps the v1 HTTP contract (`/upload`, `/videos`, `/delete`, `/process`), so existing clients keep
working. Deployment, configuration and defaults changed. Plan about 30 minutes, plus the first image
build.

## What changed

| Area | v1 | v2 |
|---|---|---|
| Architecture | One container; every `/process` call started a Python script that reloaded all models (CPU) | API + GPU worker (models stay loaded) + bundled Ollama |
| Processing | Synchronous, one request at a time (second request got 503) | Job queue: `POST /v1/jobs` + polling; `/process` still blocks, but queues instead of failing |
| Speech-to-text | openai-whisper `base` on CPU | faster-whisper `large-v3-turbo` on GPU, with VAD |
| Objects | YOLOv8n | YOLO26n (FP16), filtered by confidence and persistence |
| Language model | `deepseek-r1` (reasoning model) | `qwen3.5:4b` (vision-capable; thinking off), fixed 16K context |
| Security | Token `mysecrettoken` committed; development mode without auth by default | Strong keys required; secure defaults; see [security.md](security.md) |
| Node / Python | 18 / 3.11 | 26 (Docker; 22.12+ locally) / 3.13 (Docker; 3.12+ locally) |

## Steps

1. **Back up** what you need from `data/`. v2 does not reuse v1's cache files (`data/json`, `data/audios`),
   and they are re-created as needed.
2. **Create a fresh `.env`:** move your old file aside (`mv .env .env.v1`), run `./scripts/init.sh` (or
   `.\scripts\init.ps1`), then copy over the settings you had changed, using the table below. v1's token
   `mysecrettoken` is rejected; the new key is printed by the init script.
3. **Update your clients' token.** Keep the paths returned by `/upload`; v2 may append `-<8 hex>` to names
   that collide with a different video.
4. **Start v2:** `docker compose up -d --build`. The old `docker-compose.yml` is replaced by `compose.yaml`;
   remove any running v1 container first (`docker rm -f <container>`).
5. **Check:** `node scripts/smoke.mjs`.

## Environment variables

| v1 | v2 |
|---|---|
| `HTTP_BEARER_TOKEN` | Same, but 32+ characters and comma-separated lists allowed |
| `NODE_ENV` | Same; unset now means `production` (v1 defaulted to `development`, without auth) |
| `HTTP_PORT`, `HTTP_REQUEST_MAX_JSON_BODY_PAYLOAD_LIMIT`, `HTTP_RATE_LIMIT_*` | Same (rate limit default 60/min; uploads and jobs 10/min) |
| `VIDEO_FILE_MAX_UPLOAD_SIZE`, `VIDEOS_DIR`, `JSON_DATA_DIR`, `PROMPTS_DIR`, `FILE_RETENTION_DAYS` | Same (sizes also accept `500mb`) |
| `LOG_DIR`, `LOG_LEVEL`, `LOG_RETENTION_DAYS` | Same; logs go to stdout and `LOG_DIR` is optional |
| `PROCESSING_ONLY` | Same |
| `ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR` | Deprecated; use `PROCESSING_ROOTS=name:/dir` ([deployment.md](deployment.md#videos-that-are-not-uploaded-nas-shared-folders)) |
| `ENABLE_PROCESS_LOCK_MECHANISM` | Removed; jobs are queued (`JOBS_MAX_QUEUED`, `JOBS_PIPELINED`) |
| `AUDIOS_DIR` | Removed; audio is decoded in memory |
| `PYTHON_BINARY_PATH`, `PROCESSING_VERBOSE`, `PROCESSING_LOG_LEVEL` | Removed (worker service; `WORKER_LOG_LEVEL`) |
| `PROCESSING_WHISPER_MODEL` | Same name, now read by the worker; default `large-v3-turbo` |
| `PROCESSING_FPS` | Same (now accepts fractions, e.g. `0.5`) |
| `OLLAMA_AI_API_URL` | Same (Compose points it at the bundled Ollama; `compose.host-ollama.yaml` uses the host's) |
| `OLLAMA_AI_MODEL` | Same; default `qwen3.5:4b` ([models.md](models.md)) |
| `OLLAMA_AI_TEMPERATURE`, `OLLAMA_AI_DISABLED` | Same |
| – | New: `WORKER_TOKEN`, `OLLAMA_AI_NUM_CTX`, `OLLAMA_AI_ALLOWED_MODELS`, `GPU_SHARED_LOW_VRAM`, `PROCESSING_FEATURES`, vision and job settings ([configuration.md](configuration.md)) |

## API differences

- `/process` responses now also include `payload.result` (the parsed answer) and `payload.jobId`.
  `payload.response` is still the answer as a JSON string.
- `/process` timestamps are seconds from the start of the video, and values outside the video are clamped.
  v1 sometimes returned Unix times.
- `language` accepts any Whisper language (v1 accepted only `en` and `tr`; others fell back to `en`, as
  they still do on the legacy endpoints if the worker lacks them).
- A `model` that is not in the allowlist is replaced by the default model (with a `Warning` header)
  instead of being loaded.
- Errors are always JSON (v1 returned HTML for upload errors) with proper status codes (`413`, `415`).
- The development-only `/test` endpoint and `/swagger` are gone; the API reference is at `/docs`.
