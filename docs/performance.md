# Performance and tuning

## Measurements

Reference machine: laptop with an **RTX 4060 Laptop GPU (8 GB, Ada)**, NVIDIA driver 566.26, 32 GB RAM,
Windows 11 with Docker Desktop (WSL 2), default configuration.

| What | Result |
|---|---|
| Worker start-up (once per container start; v1 paid this, plus Python imports, on every request) | Whisper turbo 3.0 s, YOLO26n 3.8 s (including GPU kernel warm-up), EasyOCR 2.0 s |
| Speech-to-text, `large-v3-turbo` `int8_float16` | 14 s of audio in 0.72 s (about 20× real time) |
| `qwen3.5:4b` model load (from the page cache) | 2.4 s |
| `qwen3.5:4b` prompt processing / generation | about 2,900 / about 57 tokens per second |
| GPU memory: worker | about 1.2 GB with every model loaded; about 0.2 GB after the release step |
| GPU memory: `qwen3.5:4b` | 3.44 GB at a 16K context, 3.73 GB at 32K (q8_0 KV cache, flash attention), 100% on the GPU |
| Windows desktop (other apps on the same GPU) | 1–2.5 GB, depending on what is open |

### End to end

Complete jobs through the API (`node scripts/smoke.mjs`) on the GPU stack from `compose.yaml` with
`qwen3.5:4b`. The test clip is [test/fixtures/speech.mp4](../test/fixtures/speech.mp4): 14 s, a voice-over
and two scenes with on-screen text.

| Job | Total | Analysis | Captions | Summary |
|---|---|---|---|---|
| Test clip, default features (objects, OCR, scenes) | 9.8–13.7 s | 5.2–6.6 s | – | 4.6–7.0 s |
| Test clip, every feature (plus faces and captions; 1 keyframe) | 19.3 s | 5.8 s | 9.4 s | 4.0 s |
| Test clip again with another prompt (analysis cache hit) | about 4 s | cached | cached | 3.4–3.9 s |
| 5 min 9 s video (the test clip looped 22 times), every feature | 75 s | 14.7 s | 21.1 s (22 keyframes) | 39.3 s |

- **Analysis runs at about 20× real time** with every feature on: 309 s of video (310 frames at 1 frame per
  second, speech, 44 scene cuts) took 14.7 s.
- **Captions:** the first caption of a job takes 5–9 s because it loads the language model again (the model
  is unloaded during the analysis to free GPU memory). After that, a keyframe takes under 1 s.
- **On long videos the answer dominates.** The 5-minute answer listed 50 events (about 5,400 characters),
  which took 39 s to generate. If you do not need every event, limit their number in your schema's
  descriptions. The prompt still fit the 16K context in one pass (no map-reduce).
- **GPU memory** peaked at 6.5–6.9 GB of the 8 GB, measured for the whole GPU with `nvidia-smi`. That
  includes about 2.5 GB for the Windows desktop and other applications, so the stack itself used about
  4–4.5 GB: the analysis models and the language model never hold the GPU at the same time.

## Where the time goes

A job has three stages; each job's `summary.timings` reports them:

1. **Analysis** (worker): video decoding, plus speech recognition in parallel with frame analysis. The
   cost grows with video length × `PROCESSING_FPS` (frames) and with speech duration.
2. **Captions** (optional): one vision-model call per scene keyframe, up to `OLLAMA_AI_VISION_MAX_FRAMES`.
3. **Summary:** one language-model call (more for very long videos). The cost grows with the prompt length
   (fast, about 2,900 tokens/s) and especially with the **answer length** (about 57 tokens/s on the
   reference GPU). A 600-token answer takes about 10 s.

Re-running a video with another prompt, schema, model or temperature skips stage 1 entirely (analysis
cache).

## Tuning knobs

| Goal | Setting |
|---|---|
| Faster analysis of long videos | `PROCESSING_FPS=0.5` (calls, talks) or lower; `PROCESSING_FRAME_MAX_SIDE=960` |
| Skip features you do not need | `PROCESSING_FEATURES=ocr,scenes` (no objects) or per job `features` |
| Fewer OCR calls on busy video | Raise `PROCESSING_OCR_MIN_INTERVAL_SECONDS` (scene cuts are always read) |
| More accurate speech | `PROCESSING_WHISPER_COMPUTE_TYPE=float16`, `PROCESSING_WHISPER_BEAM_SIZE=5` (12 GB+ GPUs) |
| Less GPU memory | `PROCESSING_WHISPER_BATCH_SIZE=4`, `OLLAMA_AI_NUM_CTX=8192`, model `qwen3.5:2b` |
| Faster summaries | Shorter answers (fewer fields, "max 5 events" in the schema descriptions), `OLLAMA_AI_THINK=false` (default) |
| Better summaries | A larger model ([models.md](models.md)), field `description`s in the schema, a precise `videoExplanation` |
| Long videos in one pass | `OLLAMA_AI_NUM_CTX=32768` (+0.3 GB with `qwen3.5:4b`) |
| Throughput with two GPUs | One worker per GPU plus `JOBS_PIPELINED=true` and `GPU_SHARED_LOW_VRAM=false` ([deployment.md](deployment.md#several-gpus)) |

Check that the language model really runs on the GPU: `docker compose exec ollama ollama ps` must show
`100% GPU`. A CPU share means the model plus its context does not fit, and generation becomes 5–10× slower.

## CPU-only

Without a GPU (`compose.cpu.yaml`), analysis runs at roughly real time or slower, depending on the CPU.
Use `PROCESSING_WHISPER_MODEL=small`, `PROCESSING_FPS=0.25`–`0.5`, and a small language model
(`qwen3.5:2b`). Apple Silicon is faster when run natively (PyTorch uses the GPU through MPS).

## CUDA versions

faster-whisper uses CTranslate2, which ships CUDA 12 builds only, and PyTorch must use the same CUDA major
version and cuDNN in the same process. The worker therefore pins **PyTorch 2.14.1 + CUDA 12.6**
(`TORCH_VARIANT=cu126`, driver 560+, Turing to Ada GPUs), and offers **PyTorch 2.13.0 + CUDA 12.9**
(`cu129`, driver 575+) for RTX 50xx (Blackwell). PyTorch 2.15's default wheels use CUDA 13. Move to them
together with CTranslate2 once it publishes CUDA 13 wheels; Dependabot is configured not to propose the
switch on its own.
