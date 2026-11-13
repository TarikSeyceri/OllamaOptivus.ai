# Third-party notices

Ollama Optivus AI's own code is licensed under the [MIT License](LICENSE.md). The Docker images and
runtime downloads include third-party software and model weights under their own licenses. The most
important ones are listed below. The full dependency trees are pinned in `package-lock.json` and
`worker/uv.lock`.

## Licenses that need your attention

| Component | License | Notes |
|---|---|---|
| [Ultralytics YOLO](https://github.com/ultralytics/ultralytics) (object detection, YOLO26 weights) | **AGPL-3.0** (or an Ultralytics Enterprise license) | Offering a service that includes AGPL software over a network can require you to publish the source of the combined work. For closed-source or commercial use, either obtain an Enterprise license or remove `objects` from `PROCESSING_FEATURES`; the package is then never imported. |
| Ollama language models (e.g. Qwen 3.5, Gemma 4) | Per model | Check the license on each model's Ollama page before commercial use. |

## Other components

| Component | License |
|---|---|
| [Ollama](https://github.com/ollama/ollama) (server image) | MIT |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper), [CTranslate2](https://github.com/OpenNMT/CTranslate2) | MIT |
| [Whisper](https://github.com/openai/whisper) model weights (`large-v3-turbo`, converted by the faster-whisper community) | MIT |
| [EasyOCR](https://github.com/JaidedAI/EasyOCR) | Apache-2.0 |
| [OpenCV](https://opencv.org) | Apache-2.0 |
| [OpenCV Zoo](https://github.com/opencv/opencv_zoo): YuNet face detector | MIT |
| OpenCV Zoo: facial expression recognition (MobileFaceNet) | Apache-2.0 |
| [PyTorch](https://pytorch.org), torchvision | BSD-3-Clause |
| NVIDIA CUDA libraries (cuBLAS, cuDNN, … as Python wheels) | NVIDIA software license |
| [PyAV](https://github.com/PyAV-Org/PyAV) | BSD-3-Clause; bundles FFmpeg (LGPL-2.1+) |
| [FastAPI](https://github.com/fastapi/fastapi), [Uvicorn](https://github.com/encode/uvicorn), [Pydantic](https://github.com/pydantic/pydantic) | MIT / BSD-3-Clause / MIT |
| [Express](https://github.com/expressjs/express), [multer](https://github.com/expressjs/multer), [helmet](https://github.com/helmetjs/helmet), [cors](https://github.com/expressjs/cors) | MIT |
| [ollama-js](https://github.com/ollama/ollama-js), [undici](https://github.com/nodejs/undici), [zod](https://github.com/colinhacks/zod), [pino](https://github.com/pinojs/pino) | MIT |
| [swagger-ui-express](https://github.com/scottie1984/swagger-ui-express) | MIT |
