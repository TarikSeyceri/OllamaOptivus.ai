# Release checklist

CI covers linting, tests, dependency scans and a CPU Docker smoke test. It has no GPU, so check the GPU
path by hand before each release.

## Automated (CI must be green)

- [ ] API: lint, format, tests on Node 22 and 26, `npm audit` (no high or critical findings)
- [ ] Worker: Ruff and pytest on Python 3.12 and 3.13
- [ ] OSV scan of `package-lock.json` and `worker/uv.lock`
- [ ] CPU stack builds, `scripts/smoke.mjs --no-prompting` passes, and Trivy finds nothing critical in
      the API image
- [ ] CodeQL has no new alerts

## Manual (on a machine with an NVIDIA GPU)

- [ ] `docker compose build --pull && docker compose up -d`; `/health/ready` reports `ready`
- [ ] `docker compose logs worker` shows the device as `cuda:0` and the expected models
- [ ] `node scripts/smoke.mjs` passes with prompting; the answer mentions "invoice 4821" and a greeting
- [ ] `node scripts/smoke.mjs --video test/fixtures/silent.mp4` passes (no audio track)
- [ ] With `OLLAMA_AI_VISION_ENABLED=true`, a job with `features` including `captions` gets scene
      descriptions in its prompt (`GET /v1/jobs/{id}/prompt`)
- [ ] `nvidia-smi` while a job runs: peak memory below the card's size;
      `docker compose exec ollama ollama ps` shows `100% GPU`
- [ ] A video of 30 minutes or more completes (exercises the context limit and map-reduce)
- [ ] The legacy Postman requests (`/upload`, `/videos`, `/process`, `/delete`) still work
- [ ] Restart while a job runs (`docker compose restart api`): the job resumes and completes

## Publishing

- [ ] `CHANGELOG.md` and the docs are updated; the version is set in `package.json` and
      `worker/pyproject.toml`
- [ ] Tag `vX.Y.Z` and publish the release notes from the changelog
