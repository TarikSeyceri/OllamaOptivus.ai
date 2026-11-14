# Configuration reference

All configuration comes from environment variables. With Docker Compose, put them in `.env`; create it
with `scripts/init.sh` or `scripts\init.ps1`, which copies [`.env.example`](../.env.example) and fills in
random secrets. When running the API locally, it reads `.env` from its working directory. Variables that
are already set in the real environment always win over `.env`.

Each service validates its configuration at start-up and refuses to start with a list of every problem
found. Typical problems are a missing or weak token, a malformed number, or an unknown feature.

**Service** column: `API` = Node.js service, `Worker` = Python analysis service, `Compose` = only used by
`compose.yaml` (interpolation, image builds).

## Secrets

| Variable | Default | Service | Description |
|---|---|---|---|
| `HTTP_BEARER_TOKEN` | – (required) | API | API keys that clients send as `Authorization: Bearer <key>`. Several comma-separated keys are accepted at once (key rotation). Each must be at least 32 characters and not a published default. |
| `HTTP_BEARER_TOKEN_FILE` | – | API | File with one key per line (Docker/Kubernetes secrets). Combined with `HTTP_BEARER_TOKEN`. |
| `WORKER_TOKEN` | – (required in production) | API, Worker | Shared secret between the API and the worker. |
| `WORKER_TOKEN_FILE` | – | API, Worker | File variant of `WORKER_TOKEN`. |
| `OLLAMA_AI_API_KEY` / `_FILE` | – | API | Optional bearer token for an Ollama endpoint behind an authenticating proxy (or Ollama's hosted API). |

## General and HTTP (API)

| Variable | Default | Description |
|---|---|---|
| `NODE_ENV` | `production` | Anything other than `development` means production. Development enables the Swagger UI and pretty logs by default. |
| `AUTH_DISABLED` | `false` | Turns authentication off. **Allowed only with `NODE_ENV=development`**; the API refuses to start otherwise. |
| `HTTP_HOST` / `HTTP_PORT` | `0.0.0.0` / `3330` | Listen address and port. |
| `HTTP_TRUST_PROXY` | `false` | Set when a reverse proxy sits in front: number of proxy hops (e.g. `1`), `true`, or a subnet. Needed for correct client IPs in rate limiting and logs. |
| `HTTP_CORS_ORIGINS` | – | Comma-separated browser origins allowed to call the API (`*` = any). Empty disables CORS. |
| `HTTP_REQUEST_MAX_JSON_BODY_PAYLOAD_LIMIT` | `100kb` | Maximum JSON body size. |
| `HTTP_REQUEST_TIMEOUT_MS` | `1800000` | Time allowed to receive a request, including large uploads on slow links. |
| `HTTP_RATE_LIMIT_ENABLED` | `true` | Rate limiting per API key (or per IP for unauthenticated requests). Health probes are exempt. |
| `HTTP_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window. |
| `HTTP_RATE_LIMIT_MAX_REQUESTS` | `60` | Requests per window for all routes. |
| `HTTP_RATE_LIMIT_HEAVY_MAX_REQUESTS` | `10` | Requests per window for uploads and job creation. |
| `API_DOCS_ENABLED` | `true` in development, else `false` | Serves `/docs` (Swagger UI) and `/openapi.json`. The document contains no secrets. |

## Logging

| Variable | Default | Service | Description |
|---|---|---|---|
| `LOG_LEVEL` | `info` | API | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. |
| `LOG_FORMAT` | `json` (production) / `pretty` (development) | API | JSON lines are what log collectors expect. |
| `LOG_DIR` | – | API | Also write daily-rotated files there (useful outside Docker). |
| `LOG_RETENTION_DAYS` | `30` | API | Number of rotated log files kept. |
| `LOG_LEVEL` | `INFO` | Worker | `CRITICAL`, `ERROR`, `WARNING`, `INFO` or `DEBUG` (Compose: `WORKER_LOG_LEVEL`). |

Credentials, transcripts and prompts are never written to the logs.

## Storage

| Variable | Default | Service | Description |
|---|---|---|---|
| `DATA_DIR` | `data` (`/data` in Docker) | API, Worker | Root of all runtime data. The API and the worker must see the same directory. |
| `VIDEOS_DIR` | `$DATA_DIR/videos` | API | Uploaded videos. |
| `JSON_DATA_DIR` | `$DATA_DIR/json` | API | Analysis cache. |
| `PROMPTS_DIR` | `$DATA_DIR/prompts` | API | Stored prompts (see `STORE_PROMPTS`). |
| `VIDEO_FILE_MAX_UPLOAD_SIZE` | `500mb` | API | Maximum upload size; accepts `b`, `kb`, `mb`, `gb`. |
| `VIDEO_ALLOWED_EXTENSIONS` | `mp4,mov,m4v,mkv,webm` | API | Accepted containers (checked by content, not only by name). The legacy `/upload` accepts MP4 only. |
| `STORAGE_MIN_FREE_BYTES` | `1gb` | API | Uploads are refused with `507` below this much free disk space. |
| `FILE_RETENTION_DAYS` | `2` | API | Videos, analyses, keyframes, prompts and finished jobs older than this are deleted (hourly). Files used by active jobs are kept. |
| `STORE_PROMPTS` | `true` | API | Keep the prompt of each job (`GET /v1/jobs/{id}/prompt`). Prompts contain transcripts. |
| `PROCESSING_ONLY` | `false` | API | Disables upload, listing and deletion; only jobs on storage roots are allowed. |
| `PROCESSING_ROOTS` | – | API, Worker | Extra video locations as `name:/absolute/dir` pairs, comma-separated (e.g. `nas:/mnt/nas`). Mount each directory into **both** containers at the same path. The built-in root `videos` is the upload directory. |
| `ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR` | `false` | API, Worker | **Deprecated.** Lets the legacy `/process` read any path. Use `PROCESSING_ROOTS`. |

## Jobs (API)

| Variable | Default | Description |
|---|---|---|
| `JOBS_MAX_QUEUED` | `20` | Jobs waiting beyond this are refused with `503 QUEUE_FULL`. |
| `JOBS_PIPELINED` | `false` | Overlap the next video's analysis with the previous job's summary. Only useful when the worker and Ollama use different GPUs (`GPU_SHARED_LOW_VRAM=false`). |
| `JOB_TIMEOUT_MS` | `7200000` | A job running longer is cancelled (`JOB_TIMEOUT`). |
| `JOB_MAX_ATTEMPTS` | `2` | Jobs interrupted by restarts are retried this often, then marked failed. |
| `PROCESS_SYNC_TIMEOUT_MS` | `JOB_TIMEOUT_MS` | How long the legacy `POST /process` waits before answering `504` with the job id. |

## Analysis worker

| Variable | Default | Service | Description |
|---|---|---|---|
| `WORKER_URLS` | `http://127.0.0.1:8000` | API | Comma-separated worker URLs. Several workers (e.g. one per GPU) are used in parallel. |
| `WORKER_IDLE_TIMEOUT_MS` | `120000` | API | A worker that sends nothing (not even heartbeats) this long is considered hung. |
| `PROCESSING_FEATURES` | `objects,ocr,scenes` | API, Worker | Enabled analyses: `objects` (YOLO26, AGPL-3.0), `ocr` (EasyOCR), `scenes` (scene cuts), `faces` (facial expressions; read [security.md](security.md#facial-expressions-responsible-use) first). For the API it is the default per job; for the worker, what is loaded. |
| `PROCESSING_FPS` | `1` | API | Frames analyzed per second of video (per job: `sampleFps`). `0.5` is plenty for calls and talks. |
| `WORKER_ENV` | `production` | Worker | `development` enables `/docs` and allows running without a token. |
| `WORKER_HOST` / `WORKER_PORT` | `127.0.0.1` (`0.0.0.0` in Docker) / `8000` | Worker | Listen address. Never publish the worker port. |
| `MODELS_DIR` | `models` (`/models` in Docker) | Worker | Where model weights live. |
| `PROCESSING_ALLOW_DOWNLOADS` | `true` (`false` in Docker) | Worker | Allow downloading missing models at run time. Docker images bake every model in. |
| `PROCESSING_DEVICE` | `auto` | Worker | `auto` (CUDA, then Apple MPS, then CPU), `cuda`, `mps` or `cpu`. |
| `PROCESSING_RELEASE_VRAM` | `true` | Worker | Free GPU memory after each job so a language model on the same GPU fits (Compose sets it from `GPU_SHARED_LOW_VRAM`). |
| `PROCESSING_MAX_VIDEO_SECONDS` | `14400` | Worker | Longer videos are refused (`VIDEO_TOO_LONG`). |
| `PROCESSING_MAX_SAMPLE_FPS` | `5` | Worker | Upper bound for `sampleFps`. |
| `PROCESSING_FRAME_MAX_SIDE` | `1280` | Worker | Frames are downscaled to this size before analysis. |
| `PROCESSING_WHISPER_MODEL` | `large-v3-turbo` | Worker, Compose | faster-whisper model. Docker bakes it in at build time (rebuild after changing). |
| `PROCESSING_WHISPER_COMPUTE_TYPE` | `auto` | Worker | `auto` = `int8_float16` on NVIDIA GPUs, `int8` on CPU. `float16` is slightly more accurate and uses more VRAM. |
| `PROCESSING_WHISPER_BATCH_SIZE` | `8` | Worker | Batched decoding; lower it if the GPU runs out of memory. |
| `PROCESSING_WHISPER_BEAM_SIZE` | `1` | Worker | `5` is slightly more accurate and slower. |
| `PROCESSING_YOLO_MODEL` | `yolo26n.pt` | Worker | Ultralytics weights in `MODELS_DIR` (e.g. `yolo26s.pt` for more accuracy). |
| `PROCESSING_YOLO_CONFIDENCE` | `0.45` | Worker | Minimum detection confidence. |
| `PROCESSING_YOLO_BATCH_SIZE` | `8` | Worker | Frames per detection batch. |
| `PROCESSING_OCR_LANGUAGES` | `en,tr` | Worker, Compose | EasyOCR languages baked into the image. Other request languages use English OCR. |
| `PROCESSING_OCR_MIN_CONFIDENCE` | `0.4` | Worker | OCR results below this confidence are dropped. |
| `PROCESSING_OCR_CANVAS_SIZE` | `1280` | Worker | Maximum image size for text detection. |
| `PROCESSING_OCR_MIN_INTERVAL_SECONDS` | `2` | Worker | Unchanged frames are not read again; changed frames at most this often. Scene cuts are always read. |
| `PROCESSING_SCENE_CUT_THRESHOLD` | `0.7` | Worker | Histogram correlation below which a new scene starts. |
| `PROCESSING_FRAME_CHANGE_RATIO` | `0.01` | Worker | Share of changed pixels that counts as "the picture changed". |
| `PROCESSING_KEYFRAME_MAX_SIDE` | `768` | Worker | Size of keyframes sent to the vision model. |
| `PROCESSING_MAX_KEYFRAMES` | `60` | Worker | Keyframes saved per video. |
| `PROCESSING_KEYFRAME_MIN_INTERVAL_SECONDS` | `10` | Worker | Minimum distance between two keyframes. |

## Language model (Ollama, API)

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_AI_DISABLED` | `false` | Analysis only; jobs return the analysis and the prompt (`noPrompting` behaviour). |
| `OLLAMA_AI_API_URL` | `http://127.0.0.1:11434` | Ollama endpoint (`http://ollama:11434` in Compose). |
| `OLLAMA_AI_MODEL` | `qwen3.5:4b` | Model for the summary. Pulled automatically if missing. See [models.md](models.md). |
| `OLLAMA_AI_ALLOWED_MODELS` | – | Extra models clients may request. The default and vision models are always allowed; anything else is refused (v1) or replaced by the default with a `Warning` header (legacy). |
| `OLLAMA_AI_TEMPERATURE` | `0` | Default temperature. |
| `OLLAMA_AI_SEED` | – | Default seed for reproducible answers. |
| `OLLAMA_AI_NUM_CTX` | `16384` | Context window. It is **fixed**, because Ollama reloads the model whenever it changes. Longer videos are summarized in parts automatically. |
| `OLLAMA_AI_NUM_PREDICT` | `2048` | Maximum answer length in tokens. |
| `OLLAMA_AI_KEEP_ALIVE` | `5m` | How long Ollama keeps the model loaded after a request. |
| `OLLAMA_AI_THINK` | `false` | Reasoning mode of thinking models (`true`, `false`, `low`, `medium`, `high`). Off is faster and better for strict JSON. |
| `OLLAMA_AI_TIMEOUT_MS` | `600000` | Per-request timeout. |
| `OLLAMA_AI_AUTO_PULL` | `true` | Pull missing models at start-up. |
| `GPU_SHARED_LOW_VRAM` | `true` | One GPU shared by the worker and Ollama: the API unloads the model before each video analysis, and the worker frees its memory afterwards. Set to `false` if they use different GPUs. |
| `OLLAMA_AI_VISION_ENABLED` | `false` | Scene descriptions: keyframes are captioned by a vision model. |
| `OLLAMA_AI_VISION_MODEL` | `OLLAMA_AI_MODEL` | Vision model. Keep it equal to the summary model on small GPUs (no model swapping). |
| `OLLAMA_AI_VISION_MAX_FRAMES` | `30` | Maximum captions per video. |

## Docker Compose only

| Variable | Default | Description |
|---|---|---|
| `OPTIVUS_BIND` | `127.0.0.1` | Host interface the API is published on. `0.0.0.0` exposes it on every interface; prefer a TLS reverse proxy ([deployment.md](deployment.md#tls-and-a-reverse-proxy)). |
| `OPTIVUS_PORT` | `3330` | Host port. |
| `TORCH_VARIANT` | `cu126` | Worker image variant: `cu126` (NVIDIA driver 560 or newer), `cu129` (RTX 50xx, driver 575 or newer), `cpu`. |
| `API_MEM_LIMIT` / `WORKER_MEM_LIMIT` | `1g` / `8g` | Container memory limits. |
| `WORKER_LOG_LEVEL` | `INFO` | Worker log level. |
| `OLLAMA_HOST_URL` | `http://host.docker.internal:11434` | Used by `compose.host-ollama.yaml`. |

## Deprecated v1 variables

These are still accepted where noted, and the API logs a warning at start-up:
`ALLOW_PROCESS_VIDEOS_OUTSIDE_VIDEOS_DIR` (use `PROCESSING_ROOTS`), `ENABLE_PROCESS_LOCK_MECHANISM`
(jobs are queued), `AUDIOS_DIR` (audio is decoded in memory), `PROCESSING_VERBOSE` (use `LOG_LEVEL`),
`PYTHON_BINARY_PATH` and `PROCESSING_LOG_LEVEL` (the worker replaced the Python subprocess). See the
[migration guide](migration-v1-to-v2.md).
