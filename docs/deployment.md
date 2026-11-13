# Deployment

## Requirements

| | Minimum | Recommended |
|---|---|---|
| GPU | NVIDIA with 8 GB VRAM, Turing (RTX 20xx) or newer; or CPU only | NVIDIA with 12–24 GB VRAM |
| NVIDIA driver | 560 (CUDA 12.6); 575+ for the `cu129` image (RTX 50xx) | latest stable |
| CPU / RAM | 4 cores / 16 GB | 8+ cores / 32 GB |
| Disk | 30 GB (images about 12 GB, models about 5 GB, data) | SSD with room for `FILE_RETENTION_DAYS` of uploads |
| Software | Docker Engine 24+ with Compose v2.24+ | Docker 28+ |

- **Linux:** install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
  and run `sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker`.
- **Windows:** Docker Desktop with the WSL 2 backend supports NVIDIA GPUs out of the box (keep the
  Windows NVIDIA driver current).
- Check with: `docker run --rm --gpus all ubuntu nvidia-smi`.
- **macOS:** Docker cannot use Apple GPUs. Use `compose.cpu.yaml`, or run the services natively (see
  [running without Docker](#running-without-docker)), where PyTorch uses the Apple GPU (MPS).

## First start

```bash
git clone https://github.com/TarikSeyceri/OllamaOptivus.ai.git && cd OllamaOptivus.ai
./scripts/init.sh                 # Windows: .\scripts\init.ps1  - creates .env with random secrets
docker compose up -d --build      # first build downloads about 6 GB; later builds are cached
node scripts/smoke.mjs            # waits until ready, then uploads a test video and runs a job
```

On first start, Ollama pulls `OLLAMA_AI_MODEL` (3.3 GB for the default), and `/health/ready` reports
`not_ready` until that finishes. Follow it with `docker compose logs -f api`.

Variants:

```bash
docker compose -f compose.yaml -f compose.cpu.yaml up -d --build          # no NVIDIA GPU
docker compose -f compose.yaml -f compose.host-ollama.yaml up -d --build  # Ollama already runs on the host
TORCH_VARIANT=cu129 docker compose up -d --build                           # RTX 50xx (driver 575+)
```

## TLS and a reverse proxy

The API listens on `127.0.0.1:3330` by default. For remote clients, put an HTTPS reverse proxy in
front. With [Caddy](https://caddyserver.com) (automatic certificates), add `compose.override.yaml`:

```yaml
services:
  caddy:
    image: caddy:2.10
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
    networks: [frontend]
  api:
    environment:
      HTTP_TRUST_PROXY: "1"
volumes:
  caddy-data:
```

and a `Caddyfile`:

```
optivus.example.com {
    request_body {
        max_size 600MB
    }
    reverse_proxy api:3330 {
        transport http {
            read_timeout 2m   # long-poll requests wait up to 60 s
        }
    }
}
```

With nginx, set `client_max_body_size 600m;`, `proxy_read_timeout 120s;`, `proxy_request_buffering off;`,
and pass `X-Forwarded-For`. Prefer `POST /v1/jobs` with polling over the legacy blocking `POST /process`
behind proxies.

## Videos that are not uploaded (NAS, shared folders)

Mount the folder **read-only into both the API and the worker at the same path**, and declare it as a
storage root:

```yaml
# compose.override.yaml
services:
  api:
    volumes: ["/mnt/recordings:/mnt/recordings:ro"]
  worker:
    volumes: ["/mnt/recordings:/mnt/recordings:ro"]
```

```bash
# .env
PROCESSING_ROOTS=recordings:/mnt/recordings
PROCESSING_ONLY=true   # optional: disable uploads entirely
```

Then submit jobs with `{"source": {"root": "recordings", "path": "2026/11/call-17.mp4"}}`.

## Several GPUs

Run one worker per GPU and list them all in `WORKER_URLS`:

```yaml
# compose.override.yaml
services:
  worker:
    deploy:
      resources:
        reservations:
          devices: [{ driver: nvidia, device_ids: ["0"], capabilities: [gpu] }]
  worker-2:
    extends: { file: compose.yaml, service: worker }
    deploy:
      resources:
        reservations:
          devices: [{ driver: nvidia, device_ids: ["1"], capabilities: [gpu] }]
  api:
    environment:
      WORKER_URLS: http://worker:8000,http://worker-2:8000
      JOBS_PIPELINED: "true"
      GPU_SHARED_LOW_VRAM: "false"   # if Ollama has its own GPU
```

The API runs as a **single replica** per data directory (enforced by a lock file). One API easily
saturates several GPUs.

## Upgrades

```bash
git pull
docker compose build --pull
docker compose up -d
```

Queued and interrupted jobs resume after a restart. Data written by v2 stays compatible between v2
releases; see [CHANGELOG.md](../CHANGELOG.md). Coming from v1, read the [migration guide](migration-v1-to-v2.md).

## Backups

Everything lives in two named volumes: `optivus_data` (videos, analyses, jobs) and `optivus_ollama`
(models, which can be re-downloaded). Back up `optivus_data`, encrypted, if you need more than the
retention window:

```bash
docker run --rm -v optivus_data:/data:ro -v "$PWD":/backup alpine tar czf /backup/optivus-data.tgz -C /data .
```

## Monitoring

- `GET /health/live` (process up) and `GET /health/ready` (storage, worker and language model) are
  unauthenticated, for load balancers and uptime checks.
- Logs are JSON lines on stdout: `docker compose logs -f api worker`. Docker rotates them (10 MB × 5 per
  container). Each job's `summary.timings` shows where the time went.
- GPU: `nvidia-smi` on the host. `docker compose exec ollama ollama ps` shows the loaded model and whether
  it fits on the GPU (`100% GPU`).

## Running without Docker

For development, or on macOS with the Apple GPU:

```bash
# 1. Ollama: install from https://ollama.com, then `ollama serve`

# 2. Worker (Python 3.12+ and uv: https://docs.astral.sh/uv/)
cd worker
uv sync --extra cu126            # NVIDIA; use --extra cpu on Linux/Windows without a GPU, or on macOS
uv run python -m optivus_worker.download_models --models-dir ../models --faces
WORKER_ENV=development DATA_DIR=../data MODELS_DIR=../models uv run python -m optivus_worker

# 3. API (Node.js 22.12+), in the repository root
npm ci
cp .env.example .env             # then set HTTP_BEARER_TOKEN (32+ characters)
npm run dev                      # development mode: no auth, pretty logs, Swagger UI at /docs
```

On Windows, set environment variables with PowerShell (`$env:WORKER_ENV='development'`) before running
the worker.
