# API reference

The interactive reference (Swagger UI) is served at `/docs` when `API_DOCS_ENABLED=true` (the default in
development), and the OpenAPI 3.1 document at `/openapi.json`. This page explains how the API is used.

## Basics

- **Authentication:** every endpoint except `/`, `/health/*` and the docs requires
  `Authorization: Bearer <key>` (one of the keys in `HTTP_BEARER_TOKEN`).
- **Envelope:** responses are `{"success": true, "msg": "...", "payload": {...}}`, and errors are
  `{"success": false, "msg": "...", "error": {"code": "..."}, "requestId": "..."}`.
- **Request ids:** send `X-Request-Id` to correlate your logs with the server's; otherwise one is
  generated. It is returned in every response header.
- **Rate limits:** sent in the standard `RateLimit` and `RateLimit-Policy` headers; `429` when exceeded.
- **Videos** are identified by the SHA-256 of their content. **Jobs** have UUIDs.

## Quick start with curl

```bash
TOKEN=...   # printed by scripts/init.sh
API=http://127.0.0.1:3330

# 1. Upload (identical bytes uploaded twice return the same id)
curl -s -H "Authorization: Bearer $TOKEN" -F "video=@meeting.mp4" $API/v1/videos
# -> payload.video.id = "3f0c...e9"

# 2. Start a job and wait up to 60 s for it (it keeps running if it takes longer)
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"videoId":"3f0c...e9","language":"en","videoExplanation":"A weekly team meeting."}' \
  "$API/v1/jobs?wait=60"
# -> 200 with payload.job.result when finished, else 202 with payload.job.id

# 3. Poll (long-poll up to 60 s per call)
curl -s -H "Authorization: Bearer $TOKEN" "$API/v1/jobs/<job-id>?wait=30"
```

## Videos

| Method and path | Description |
|---|---|
| `POST /v1/videos` | Multipart upload in the field `video`. Returns `201` with the video, or `200` when identical bytes were uploaded before. The container is checked by content (MP4/MOV, MKV/WebM, AVI) and must be in `VIDEO_ALLOWED_EXTENSIONS`. |
| `GET /v1/videos?limit=100&offset=0` | Lists videos, newest first. |
| `GET /v1/videos/{id}` | One video. |
| `DELETE /v1/videos/{id}` | Deletes the video and everything derived from it (cached analyses, keyframes). `409` while a job uses it. |

Video management is disabled (`403`) with `PROCESSING_ONLY=true`.

## Jobs

### `POST /v1/jobs`

```json
{
  "videoId": "3f0c...e9",
  "language": "en",
  "videoExplanation": "A recorded support call between an agent and a customer.",
  "model": "qwen3.5:4b",
  "temperature": 0,
  "seed": 42,
  "format": { "type": "object", "properties": { "summary": { "type": "string" } }, "required": ["summary"] },
  "features": ["objects", "ocr", "scenes", "captions"],
  "sampleFps": 1,
  "noPrompting": false
}
```

Exactly one of `videoId` or `source` is required:

- `source: {"root": "nas", "path": "calls/2026/call-17.mp4"}` processes a file in a storage root
  (`PROCESSING_ROOTS`) without uploading it.
- `language`: ISO 639-1 code (`en`, `tr`, `de`, …) or `auto`. It sets the speech recognition language, the
  OCR language (if baked into the worker) and the language of the answer.
- `format`: an Ollama structured-output JSON schema, or `"json"` for free-form JSON. The default schema is
  `{summary, events[{timestamp, description}]}`. Field `description`s are passed to the model, so use them.
  See [examples/call-center-format.json](examples/call-center-format.json).
- `features`: defaults to `PROCESSING_FEATURES`, plus `captions` when vision is enabled.
- `noPrompting`: analyze and build the prompt, but do not call the language model.
- `?wait=N` (0–60): wait up to N seconds; returns `200` if the job finished in time.

An identical active job (same video content and same options) is reused rather than started twice
(`payload.deduplicated: true`).

### `GET /v1/jobs/{id}?wait=N`

```json
{
  "id": "0b4d...",
  "status": "completed",
  "stage": "done",
  "progress": 1,
  "createdAt": "...", "startedAt": "...", "finishedAt": "...", "durationMs": 21734,
  "video": { "id": "3f0c...e9", "root": "videos", "path": "3f0c...e9.mp4", "size": 262490 },
  "request": { "language": "en", "model": "qwen3.5:4b", "features": ["objects", "ocr", "scenes"], "...": "..." },
  "summary": {
    "duration": 14, "hasAudio": true, "transcriptSegments": 3, "sampledFrames": 14, "sceneCuts": 2,
    "device": "cuda:0", "timings": { "analysisMs": 4210, "llmMs": 15880 },
    "llm": { "model": "qwen3.5:4b", "promptTokens": 1559, "outputTokens": 412, "stoppedEarly": true }
  },
  "warnings": ["..."],
  "result": { "summary": "...", "events": [{ "timestamp": 7, "description": "..." }] },
  "response": "{\"summary\":\"...\"}"
}
```

- **Statuses:** `queued` (`position` = place in the queue), `running`, `completed`, `failed` (with
  `error.code` and `error.message`), `canceled`.
- **Stages:** `queued`, `analyzing` (worker), `describing` (keyframe captions), `summarizing` (language
  model), `done`.
- `result` is the parsed answer and `response` the same answer as a JSON string. Timestamps outside the
  video are clamped, and `warnings` says so.

### Other job endpoints

| Method and path | Description |
|---|---|
| `GET /v1/jobs?status=running&limit=50` | Recent jobs. |
| `GET /v1/jobs/{id}/analysis` | The raw analysis: transcript, sampled frames (objects, texts, scene cuts, faces, captions), scenes, timings. |
| `GET /v1/jobs/{id}/prompt` | The prompt sent to the model (`text/plain`; needs `STORE_PROMPTS=true`). |
| `DELETE /v1/jobs/{id}` | Cancels an active job (`202`) or deletes a finished one (`200`). |

## System

| Method and path | Description |
|---|---|
| `GET /health/live` | Liveness, no authentication. |
| `GET /health/ready` | Readiness of storage, worker and language model, no authentication. `503` until everything is ready. |
| `GET /v1/models` | Default and vision models, allowed models and whether they are installed. |
| `GET /v1/capabilities` | Languages, features, OCR languages, model versions and device of the worker. |

## Legacy v1 endpoints

`GET /`, `POST /upload`, `GET /videos`, `DELETE /delete` and `POST /process` keep their v1 request and
response format. They answer with a `Deprecation` header; new integrations should use `/v1`.

Differences from v1:

- `/upload` checks the file content (magic bytes) and sanitizes the name. A different video with an existing
  name is stored as `name-<8 hex>.mp4` instead of silently returning the old file. Always use the returned
  `videoFilePath`.
- `/process` runs as a job. A second request no longer gets `503` while another video is processing; it
  waits in the queue. If the client disconnects, the job keeps running, and an identical retry attaches to it.
- `/process` payloads also contain `result` (the parsed answer) and `jobId`. A `model` that is not
  allowed is replaced by the default, with a `Warning` header.

## Error codes

| HTTP | `error.code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED`, `MALFORMED_JSON`, `BAD_REQUEST` | The request is invalid; `error.details` lists each problem. |
| 400 | `MODEL_NOT_ALLOWED`, `UNSUPPORTED_LANGUAGE`, `FEATURE_UNAVAILABLE`, `UNKNOWN_ROOT`, `INVALID_FILE_TYPE`, `NO_VIDEO_STREAM`, `INVALID_VIDEO` | The request cannot be served as asked. |
| 401 | `UNAUTHORIZED` | Missing or wrong bearer token. |
| 403 | `PATH_NOT_ALLOWED`, `FORBIDDEN` | Path outside the storage roots, or video management disabled. |
| 404 | `VIDEO_NOT_FOUND`, `JOB_NOT_FOUND`, `ANALYSIS_NOT_FOUND`, `PROMPT_NOT_FOUND`, `NOT_FOUND` | Not found or expired (retention). |
| 409 | `CONFLICT`, `NAME_CONFLICT` | The video is used by an active job. |
| 413 | `LIMIT_FILE_SIZE`, `BODY_TOO_LARGE`, `VIDEO_TOO_LONG`, `VIDEO_TOO_LONG_FOR_CONTEXT` | Too large or too long. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Not a supported video container. |
| 429 | `RATE_LIMITED` | Too many requests. |
| 503 | `QUEUE_FULL`, `LLM_UNAVAILABLE`, `WORKER_UNAVAILABLE`, `SHUTTING_DOWN` | Try again later. |
| 504 | `JOB_TIMEOUT`, `LLM_TIMEOUT` | Took too long. |
| 507 | `INSUFFICIENT_STORAGE`, `OUT_OF_GPU_MEMORY` | Not enough disk space or GPU memory. |
| 5xx | `INTERNAL`, `WORKER_ERROR`, `LLM_ERROR`, `LLM_INVALID_JSON` | Server-side failure; see the logs (search for the `requestId`). |
