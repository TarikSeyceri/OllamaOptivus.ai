# Troubleshooting

Start with `GET /health/ready` (which component is not ready?) and the logs:
`docker compose logs --tail=100 api worker ollama`. Every API error carries a `requestId`; search the
logs for it.

## Start-up

**`Invalid configuration - refusing to start`**: the message lists every problem. Most often it is a
missing or weak `HTTP_BEARER_TOKEN` or `WORKER_TOKEN`; run `./scripts/init.sh` (or `.\scripts\init.ps1`).

**`required variable HTTP_BEARER_TOKEN is missing a value`** (Compose): there is no `.env` yet; run the
init script.

**`Another API instance ... is using /data`**: two API containers share one data volume. Run one API per
data directory. A crashed instance's lock expires after 90 s.

**`could not select device driver "nvidia"`**: Docker cannot see the GPU. Install the NVIDIA Container
Toolkit (Linux) or update Docker Desktop and the Windows NVIDIA driver. Check with
`docker run --rm --gpus all ubuntu nvidia-smi`. Without a GPU, use `compose.cpu.yaml`.

**Worker `/readyz` stays `503` with an error:**

- `no kernel image is available` / `is not supported by this PyTorch build`: your GPU is too old for the
  image. Build with `TORCH_VARIANT=cu126` (Turing to Ada) or `cu129` (Blackwell); for older GPUs use `cpu`.
- `CUDA driver version is insufficient`: update the NVIDIA driver (560+ for `cu126`, 575+ for `cu129`).
- `libcudnn` / `libcublas` not found (faster-whisper): rebuild the image. When running without Docker, set
  `LD_LIBRARY_PATH` as described in [deployment.md](deployment.md#running-without-docker).

**`/health/ready` reports `llm: unavailable` for a long time**: the first start pulls the model (3.3 GB
for the default); watch `docker compose logs -f api`. With `compose.host-ollama.yaml`, make sure Ollama
on the host listens on an address reachable from containers (`OLLAMA_HOST=0.0.0.0`).

## Jobs

**Job `failed` with `OUT_OF_GPU_MEMORY`**: another process uses the GPU (a desktop, browser or second
model). On 8 GB keep `GPU_SHARED_LOW_VRAM=true`. Then try, in this order:

1. lower `PROCESSING_WHISPER_BATCH_SIZE` (e.g. `4`);
2. lower `PROCESSING_FRAME_MAX_SIDE` (e.g. `960`);
3. use a smaller language model (`qwen3.5:2b`).

**Very slow summaries**: run `docker compose exec ollama ollama ps`. If the processor column shows a CPU
share (e.g. `30%/70% CPU/GPU`), the model does not fit on the GPU. Use a smaller model or a smaller
`OLLAMA_AI_NUM_CTX`. The API logs `model is partially loaded in system RAM` when this happens.

**`VIDEO_TOO_LONG_FOR_CONTEXT`**: even the condensed notes exceed the context window. Raise
`OLLAMA_AI_NUM_CTX` (needs more VRAM) or lower `PROCESSING_FPS`.

**`LLM_INVALID_JSON`**: the model produced invalid JSON twice. Use a stronger model, simplify the
`format` schema, or set `OLLAMA_AI_THINK=false` (the default).

**Wrong language in the answer**: set `language` explicitly. With `auto`, the answer uses the language
the speech recognizer detected.

**The transcript is empty**: the video has no audio track (`summary.hasAudio=false`), or the speech is
too quiet for voice-activity detection. Check `GET /v1/jobs/{id}/analysis`.

**Hallucinated speech on music or silence**: segments that Whisper itself rates as unlikely speech are
dropped. For noisy recordings use `PROCESSING_WHISPER_BEAM_SIZE=5`.

## Uploads

- `413`: raise `VIDEO_FILE_MAX_UPLOAD_SIZE` (and the reverse proxy's body limit).
- `415`: the file is not MP4/MOV/MKV/WebM/AVI by content, or not in `VIDEO_ALLOWED_EXTENSIONS`. Legacy
  `/upload` accepts MP4 only.
- `507`: free disk space below `STORAGE_MIN_FREE_BYTES`; lower `FILE_RETENTION_DAYS` or add disk.
- Uploads that time out behind a proxy: raise the proxy's timeouts and `HTTP_REQUEST_TIMEOUT_MS`.

## Legacy `/process` returns `504`

The job is still running (`PROCESS_SYNC_TIMEOUT_MS`), or a proxy gave up first. The response contains
`payload.jobId`; fetch the result with `GET /v1/jobs/{jobId}`. Better: switch the client to
`POST /v1/jobs` and polling.
