# Contributing

Thank you for helping improve Ollama Optivus AI. Bug reports, documentation fixes and pull requests are
all welcome.

## Development setup

You need Node.js 22.12+ (26 recommended), [uv](https://docs.astral.sh/uv/), and Docker for the full stack.

```bash
npm ci                                  # API dependencies
npm test                                # API tests (fakes: no GPU, no Ollama, no Python needed)
npm run lint && npm run format:check

cd worker
uv sync                                 # light environment with fake models
uv run pytest
uv run ruff check . && uv run ruff format --check .
```

To run the real stack, see [docs/deployment.md](docs/deployment.md). `node scripts/smoke.mjs` checks it
end to end.

## Project layout

```
src/                 API (Node.js, ESM)
  config.js          environment -> validated config
  http/              routes, middleware, schemas (zod), OpenAPI
  core/storage/      video store, paths, retention
  core/jobs/         queue, persistence, the job pipeline
  core/llm/          Ollama client, timeline/prompt builder, summary, captions
  core/analysis/     worker client, analysis format, cache
worker/              Python analysis service (FastAPI)
  optivus_worker/    media decoding, speech, objects, OCR, scenes, faces, HTTP API
test/                API tests (black-box against the real server with fakes) and fixtures
docs/                documentation
```

## Guidelines

- **Tests:** every bug fix gets a regression test, and every feature gets tests. API tests start the real
  server (`test/helpers/harness.mjs`) with a fake Ollama and a fake worker. Worker tests use
  `OPTIVUS_FAKE_MODELS`.
- **Compatibility:** the legacy v1 endpoints are covered by `test/legacy-api.test.mjs`; do not break them.
  The prompt format is pinned by a golden file. After a deliberate change, run
  `UPDATE_GOLDEN=1 npm test` and review the diff.
- **Security:** validate all input with schemas, never trust file names or MIME types, keep paths inside
  their roots, and never log secrets or transcripts.
- **Dependencies:**
  - Pin exact versions, and only adopt releases that are at least 14 days old (supply-chain policy).
  - For the worker, edit `worker/pyproject.toml`, then run `uv lock`. The `exclude-newer` date in
    `pyproject.toml` enforces the age rule.
  - torch stays on a CUDA 12 build until CTranslate2 supports CUDA 13.
- **Style:** Prettier and ESLint (JavaScript), Ruff (Python). Write documentation in plain, direct
  English.
- **Docs:** update `docs/` and `CHANGELOG.md` with every user-visible change.

## Pull requests

1. Fork, then create a branch (`feature/...` or `fix/...`).
2. Make the change with tests and docs; make sure `npm test`, the worker tests and the linters pass.
3. Open a pull request that explains what changed and why. CI runs the tests, the security scans and a
   Docker smoke test.

Report bugs and request features through [GitHub Issues](https://github.com/TarikSeyceri/OllamaOptivus.ai/issues).
Include the version, your configuration (without secrets), what you expected, and the logs with the
`requestId`. Report security issues privately ([SECURITY.md](SECURITY.md)).
