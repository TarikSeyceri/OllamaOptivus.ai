# Security

Optivus processes recordings that often contain personal data: faces, voices, names, account numbers.
This page describes what the system protects against, how, and what you must do as the operator.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Threat model

| Threat | Mitigation |
|---|---|
| Unauthorized use of the API | Mandatory bearer keys (32+ characters; published defaults rejected); the API refuses to start without them. Comparison is constant-time. Per-key and per-IP rate limits. |
| Credential leaks | Secrets come from `.env` (file mode 600) or `*_FILE` (Docker secrets). They are redacted from logs, and client API keys are never forwarded to the worker or Ollama. |
| Reading files outside the allowed folders (path traversal) | Videos are addressed by id, or by `{root, path}` within named roots. Paths are checked lexically and again after resolving symlinks, in the API **and** in the worker. Keyframes can only be written below `data/frames/`. |
| Malicious uploads | Size limit, one file per request, magic-byte container check (the name and MIME type are not trusted), sanitized names, random temp names, atomic moves, a free-disk check. |
| Denial of service | Strict JSON schemas and size limits on every input, including caps on client-supplied JSON schemas. Bounded queue, per-job and per-request timeouts, limits on video duration and sample rate, container memory and PID limits. |
| Prompt injection from the video (speech or on-screen text like "ignore previous instructions") | Instructions live in the system prompt; the analysis is wrapped in `<video_analysis>` tags and declared to be data. Answers must follow the JSON schema. Treat the model's output as untrusted: never execute it, and review fraud or compliance scores before acting on them. |
| Abuse of the model server | Only allowed models can be requested. Ollama is never published, and has no authentication of its own. |
| Lateral movement after a compromise | The worker has no internet access (internal network). Containers run as non-root (Ollama excepted), with read-only root filesystems, all Linux capabilities dropped, and `no-new-privileges`. |
| Supply-chain attacks | Exact pins (hash-verified lockfiles for npm and uv); only releases at least 14 days old; actions pinned to commit SHAs; npm install scripts disabled in the image; model weights pinned by revision and SHA-256. CI runs OSV, `npm audit`, Trivy and CodeQL; Dependabot has a 14-day cooldown. |
| Information leaks in errors | Errors are always JSON, never stack traces, and carry a request id for correlation. Health probes reveal no versions or paths. |

## Production checklist

1. **Secrets:** create `.env` with `scripts/init.sh` (or `init.ps1`); never commit it. To rotate a key, add the
   new one next to the old one (`HTTP_BEARER_TOKEN=new,old`), update clients, then remove the old one.
2. **TLS:** keep `OPTIVUS_BIND=127.0.0.1` and put a reverse proxy with HTTPS in front (see
   [deployment.md](deployment.md#tls-and-a-reverse-proxy)), then set `HTTP_TRUST_PROXY=1`.
3. **Firewall:** only the proxy port should be reachable. Docker-published ports bypass `ufw`/`firewalld`
   rules on Linux, which is one more reason to bind to `127.0.0.1`.
4. **Docs:** leave `API_DOCS_ENABLED=false` on internet-facing deployments (the default).
5. **Retention:** set `FILE_RETENTION_DAYS` to the minimum your process needs, and `STORE_PROMPTS=false` if
   you do not need to audit prompts.
6. **Models:** keep `OLLAMA_AI_ALLOWED_MODELS` short.
7. **Updates:** apply Dependabot updates and rebuild the images regularly; read the CI security reports.
8. **Backups:** the data volume holds recordings and transcripts. Encrypt backups and treat them like the
   original recordings.
9. **CORS:** set `HTTP_CORS_ORIGINS` only if browsers call the API directly, and list exact origins.

## Personal data

- **What is stored:** uploaded videos; analyses (transcripts, on-screen text, detected objects, facial
  expressions if enabled); keyframes; prompts; answers. Everything stays on your servers. Ollama runs
  locally, and model weights are the only things downloaded.
- **How long:** `FILE_RETENTION_DAYS` (default 2) for everything, measured from creation or completion.
  `DELETE /v1/videos/{id}` removes a video and all derived data immediately.
- **Logs:** request metadata only (method, path, status, timing, request id), with no transcripts, prompts
  or tokens.
- **Your obligations:** recording and analyzing people usually requires a legal basis and transparency (for
  example GDPR/KVKK notices to the people being recorded). Optivus does not handle consent; your processes
  must.

## Facial expressions: responsible use

The `faces` feature labels facial expressions (angry, disgust, fearful, happy, neutral, sad, surprised).
Keep these limits in mind:

- **An expression is not an emotion.** People express feelings differently across cultures and
  situations, and classifiers are less accurate for some groups. Never base decisions about people on
  these labels.
- **Legal limits:** the EU AI Act, Article 5(1)(f), **prohibits AI systems that infer the emotions of people in
  the workplace and in education**, except for medical or safety reasons. Analyzing call-center agents or
  employees in recorded meetings falls under this prohibition in the EU. Other jurisdictions have related
  rules on biometric data.
- The feature is **off by default**. Enable it (`PROCESSING_FEATURES=...,faces`) only where it is lawful and
  proportionate, and document why.

## What Optivus does not do

- It does not identify people (no face recognition, no speaker identification).
- It does not encrypt data at rest. Use encrypted disks or volumes.
- It is single-tenant: every API key sees all videos and jobs. Run separate instances for separate
  customers. Content deduplication also means a key holder can tell whether a given file was already
  uploaded.
