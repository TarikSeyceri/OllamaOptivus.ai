"""Downloads and verifies every model the worker can use into MODELS_DIR.

Used when the Docker image is built (PRELOAD_MODELS=true), so containers run fully offline, and for
local development:  python -m optivus_worker.download_models --models-dir models --faces

Every download is pinned: Whisper to a Hugging Face revision, the OpenCV Zoo models to a commit and
a SHA-256, YOLO weights to a SHA-256. EasyOCR verifies its own weights (MD5) after download.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path

OPENCV_ZOO_COMMIT = "eb9f4f2d4b79b58e5513b5d25d5f0243a8357bf4"
_ZOO = f"https://media.githubusercontent.com/media/opencv/opencv_zoo/{OPENCV_ZOO_COMMIT}/models"
FACE_FILES = {
    "face_detection_yunet_2023mar.onnx": (
        f"{_ZOO}/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    ),
    "facial_expression_recognition_mobilefacenet_2022july.onnx": (
        f"{_ZOO}/facial_expression_recognition/facial_expression_recognition_mobilefacenet_2022july.onnx",
        "4f61307602fc089ce20488a31d4e4614e3c9753a7d6c41578c854858b183e1a9",
    ),
}
YOLO_SHA256 = {"yolo26n.pt": "9b09cc8bf347f0fc8a5f7657480587f25db09b34bf33b0652110fb03a8ad4fef"}
WHISPER_REVISIONS = {"large-v3-turbo": "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"}


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def verify(path: Path, expected: str | None) -> None:
    actual = sha256_of(path)
    if expected and actual != expected:
        path.unlink(missing_ok=True)
        raise SystemExit(f"Checksum mismatch for {path.name}: expected {expected}, got {actual}")
    print(f"  {path.name}  sha256={actual}{'  (verified)' if expected else '  (no pin)'}")


def fetch(url: str, target: Path, expected: str) -> None:
    if target.exists() and sha256_of(target) == expected:
        print(f"  {target.name} already present")
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    with (
        tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as tmp,
        urllib.request.urlopen(url, timeout=120) as response,  # noqa: S310 - fixed https URLs above
    ):
        shutil.copyfileobj(response, tmp)
    tmp_path = Path(tmp.name)
    verify(tmp_path, expected)
    tmp_path.replace(target)


def download_whisper(name: str, models_dir: Path) -> None:
    from faster_whisper.utils import download_model

    print(f"Whisper {name}")
    download_model(name, output_dir=str(models_dir / "whisper" / name), revision=WHISPER_REVISIONS.get(name))


def download_yolo(name: str, models_dir: Path) -> None:
    os.environ.setdefault("YOLO_VERBOSE", "False")
    from ultralytics.utils.downloads import attempt_download_asset

    print(f"YOLO {name}")
    target = models_dir / name
    target.parent.mkdir(parents=True, exist_ok=True)
    path = Path(attempt_download_asset(str(target)))
    verify(path, YOLO_SHA256.get(name))


def download_easyocr(languages: list[str], models_dir: Path) -> None:
    import easyocr

    print(f"EasyOCR {', '.join(languages)}")
    for language in languages:  # one reader per language group so every recognizer is cached
        group = ["en"] if language == "en" else [language, "en"]
        easyocr.Reader(
            group, gpu=False, model_storage_directory=str(models_dir / "easyocr"), download_enabled=True, verbose=False
        )


def download_faces(models_dir: Path) -> None:
    print("Face models (OpenCV Zoo)")
    for file_name, (url, expected) in FACE_FILES.items():
        fetch(url, models_dir / "faces" / file_name, expected)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--models-dir", type=Path, default=Path(os.environ.get("MODELS_DIR", "models")))
    parser.add_argument("--whisper", default="large-v3-turbo", help='faster-whisper model, or "none"')
    parser.add_argument("--ocr-languages", default="en,tr", help='comma-separated EasyOCR languages, or "none"')
    parser.add_argument("--yolo", default="yolo26n.pt", help='Ultralytics weights, or "none"')
    parser.add_argument("--faces", action="store_true", help="also download the facial-expression models")
    args = parser.parse_args(argv)

    args.models_dir.mkdir(parents=True, exist_ok=True)
    if args.whisper != "none":
        download_whisper(args.whisper, args.models_dir)
    if args.yolo != "none":
        download_yolo(args.yolo, args.models_dir)
    if args.ocr_languages != "none":
        download_easyocr([lang.strip() for lang in args.ocr_languages.split(",") if lang.strip()], args.models_dir)
    if args.faces:
        download_faces(args.models_dir)
    print(f"Models are in {args.models_dir.resolve()}")


if __name__ == "__main__":
    sys.exit(main())
