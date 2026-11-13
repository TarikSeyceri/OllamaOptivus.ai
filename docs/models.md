# Choosing models

Optivus combines several models. All of them run locally; nothing is sent to a cloud service.

| Role | Default | Where it runs | Configured with |
|---|---|---|---|
| Summary (the JSON answer) | `qwen3.5:4b` | Ollama | `OLLAMA_AI_MODEL` |
| Scene descriptions (keyframe captions) | same model as the summary | Ollama | `OLLAMA_AI_VISION_MODEL` |
| Speech-to-text | faster-whisper `large-v3-turbo` | worker | `PROCESSING_WHISPER_MODEL` |
| Objects | YOLO26n | worker | `PROCESSING_YOLO_MODEL` |
| On-screen text | EasyOCR | worker | `PROCESSING_OCR_LANGUAGES` |
| Facial expressions (opt-in) | YuNet + MobileFaceNet | worker (CPU) | `PROCESSING_FEATURES` |

The recommendations below are from November 2026. Model releases move quickly: compare candidates on your
own videos with the benchmark script at the end of this page.

## Language model (summary and captions)

What makes a model good for this job:

- reliable **structured JSON output**;
- good **long-context reading** (a one-hour call is roughly 15K tokens);
- **multilingual** answers;
- **vision**, so that one model can also caption keyframes. Using a single model means no model swapping
  on small GPUs.

The current Qwen 3.5 and Gemma 4 families tick all four boxes.

| GPU memory | Recommended | Also good | Notes |
|---|---|---|---|
| **8 GB** (default) | `qwen3.5:4b` (3.3 GB download) | `qwen3.5:2b` (1.9 GB) if memory is tight | Measured on an RTX 4060 Laptop: fully on the GPU at 16K context (3.44 GB) and at 32K (3.73 GB), with prompt processing at about 2,900 tokens/s and generation at about 57 tokens/s. |
| 12–16 GB | `qwen3.5:9b` (6.6 GB) | `gemma4:12b` (about 8 GB), `gemma4:e4b` | Noticeably better reasoning over long calls. |
| 24 GB | `gemma4:26b` (mixture-of-experts, about 18 GB, about 4B active parameters, so it is fast) | `qwen3.5:27b` (17 GB, dense) | Best quality per second on a single consumer GPU. |
| 48–80 GB | `qwen3.5:35b-a3b` at q8 (39 GB) or `gemma4:31b` at q8 (34 GB) | `gpt-oss:120b` (text only, about 65 GB) | With a text-only summary model, set `OLLAMA_AI_VISION_MODEL` to a vision model (e.g. `qwen3.5:9b`). |
| CPU or Apple Silicon | `qwen3.5:2b` | `qwen3.5:4b` | Expect seconds per sentence; keep `PROCESSING_FPS` low. |

Notes:

- **`deepseek-r1` (the v1 default) is no longer recommended.** It is a year-old reasoning model: it spends
  many tokens "thinking" before answering, which is slow, and it is weaker at strict JSON than current
  instruction models.
- `qwen3.6` and `qwen3.8` were days or weeks old when this was written. Try them with the benchmark
  before adopting them.
- Thinking models (Qwen 3.5, Gemma 4, gpt-oss) run with `OLLAMA_AI_THINK=false` by default, which is faster
  and better for strict JSON. gpt-oss cannot switch thinking off completely; use `OLLAMA_AI_THINK=low`.
- **Context:** `OLLAMA_AI_NUM_CTX=16384` fits about 45 minutes of conversation in one pass. Longer videos
  are summarized in parts automatically. On GPUs with 12 GB or more, `32768` avoids most splitting.
- **Allowlist:** clients may only use models listed in `OLLAMA_AI_ALLOWED_MODELS` (plus the default and
  vision models), so nobody can make the server load a huge model.

## Speech-to-text (Whisper)

| Hardware | Model and precision | GPU memory | Notes |
|---|---|---|---|
| NVIDIA GPU (default) | `large-v3-turbo`, `int8_float16` | about 0.8 GB | 99 languages. A 14 s clip takes 0.7 s on an RTX 4060 Laptop. |
| NVIDIA, 12 GB or more | `large-v3-turbo`, `float16` | about 1.6 GB | Slightly more accurate. |
| Best accuracy | `large-v3`, `float16` | about 3.5 GB | About 3× slower than turbo. |
| English only | `distil-large-v3` | about 1.5 GB | Faster; English only. |
| CPU | `small` (or `base`), `int8` | – | `compose.cpu.yaml` uses `small` by default. |

The model is baked into the worker image at build time. After changing `PROCESSING_WHISPER_MODEL`, rebuild
with `docker compose build worker`.

## Objects (YOLO26)

`yolo26n` (40.9 COCO mAP) is the default: about 5 ms per frame on a laptop GPU. `yolo26s` (48.6 mAP) is
more accurate at about twice the compute. To use it, download it with
`python -m optivus_worker.download_models --yolo yolo26s.pt --whisper none --ocr-languages none` (or add it
to the image) and set `PROCESSING_YOLO_MODEL=yolo26s.pt`.

**Licence:** Ultralytics YOLO is AGPL-3.0. If that is a problem for your use, remove `objects` from
`PROCESSING_FEATURES`; the package is then never imported.

## On-screen text (EasyOCR)

EasyOCR runs on the GPU and is gated by scene changes, so static frames are not read twice. The languages
in `PROCESSING_OCR_LANGUAGES` are baked into the image (default `en,tr`). Other request languages use English
OCR. To add, say, German: set `PROCESSING_OCR_LANGUAGES=en,tr,de` and rebuild the worker.

## Facial expressions

These are the OpenCV Zoo models: YuNet for face detection (MIT) and a MobileFaceNet expression classifier
(Apache-2.0, 7 classes, 88% on RAF-DB). They run on the CPU, only on frames with a person. They are off by
default; read the [responsible-use note](security.md#facial-expressions-responsible-use) before enabling
them.

## Benchmark candidates on your own videos

1. Run a job once (any model) and save its analysis:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" $API/v1/jobs/<job-id>/analysis > analysis.json
   ```

2. Compare models with exactly the production prompt. Run this where Ollama is reachable. With the bundled
   Ollama, that means inside the stack:

   ```bash
   mkdir -p bench-results   # on Linux also: chmod 777 bench-results (the container runs as uid 10001)
   docker compose run --rm --no-deps \
     -v "$PWD/scripts:/app/scripts:ro" -v "$PWD/analysis.json:/app/analysis.json:ro" \
     -v "$PWD/bench-results:/app/bench-results" \
     api node scripts/bench-models.mjs --analysis analysis.json --ollama http://ollama:11434 \
     --models qwen3.5:4b,qwen3.5:9b,gemma4:e4b
   ```

   The script prints load time, prompt and generation speed, VRAM use, the GPU share and JSON validity
   per model, and writes each answer to `bench-results/`. Judge the answers, not only the speed. Pull the
   candidates first (`docker compose exec ollama ollama pull <model>`).
