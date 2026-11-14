# syntax=docker/dockerfile:1.10
# Ollama Optivus AI - API service (Node.js). No GPU, no Python: the analysis runs in ./worker.

ARG NODE_IMAGE=node:26-trixie-slim

# ---------------------------------------------------------------------------
# deps: production dependencies only, install scripts disabled (supply-chain hardening)
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---------------------------------------------------------------------------
# runtime
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
LABEL org.opencontainers.image.title="optivus-api" \
      org.opencontainers.image.description="Ollama Optivus AI API: uploads, jobs, prompts and the Ollama client" \
      org.opencontainers.image.source="https://github.com/TarikSeyceri/OllamaOptivus.ai" \
      org.opencontainers.image.licenses="MIT"

# Same UID/GID as the worker: both write to the shared data volume. /data is created here so a new
# named volume inherits this ownership.
RUN groupadd --system --gid 10001 optivus \
 && useradd --system --uid 10001 --gid optivus --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin optivus \
 && mkdir -p /data \
 && chown 10001:10001 /data

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HTTP_HOST=0.0.0.0 \
    HTTP_PORT=3330

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER 10001:10001
EXPOSE 3330
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=3s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3330/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "src/main.js"]
