"""Facial expressions with OpenCV Zoo models, run on the CPU through cv2.dnn (no extra packages):

- YuNet face detector with 5 landmarks (MIT licence), and
- a MobileFaceNet facial-expression classifier, 7 classes, 88% on RAF-DB (Apache-2.0).

Responsible use: facial expressions are not reliable evidence of how someone feels, and the EU AI
Act (Art. 5(1)(f)) prohibits emotion recognition in workplaces and education. The feature is off by
default (PROCESSING_FEATURES must include "faces").
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from .errors import AnalysisError

DETECTOR_FILE = "face_detection_yunet_2023mar.onnx"
CLASSIFIER_FILE = "facial_expression_recognition_mobilefacenet_2022july.onnx"
EXPRESSIONS = ("angry", "disgust", "fearful", "happy", "neutral", "sad", "surprised")
# Landmark positions of a canonical 112x112 face (eyes, nose tip, mouth corners).
REFERENCE_POINTS = np.array(
    [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]],
    dtype=np.float32,
)


class FaceExpressionAnalyzer:
    def __init__(self, models_dir: Path, min_face_px: int = 40, max_faces: int = 10) -> None:
        detector = models_dir / "faces" / DETECTOR_FILE
        classifier = models_dir / "faces" / CLASSIFIER_FILE
        if not detector.exists() or not classifier.exists():
            raise AnalysisError(
                "FEATURE_UNAVAILABLE", f"Face models are missing in {detector.parent}; run download_models --faces."
            )
        self.detector = cv2.FaceDetectorYN.create(str(detector), "", (320, 320), 0.8, 0.3, 50)
        self.classifier = cv2.dnn.readNet(str(classifier))
        self.min_face_px = min_face_px
        self.max_faces = max_faces
        self.id = "opencv-zoo:yunet-2023mar+fer-mobilefacenet-2022july"

    def analyze(self, image: np.ndarray) -> list[dict]:
        height, width = image.shape[:2]
        self.detector.setInputSize((width, height))
        _, faces = self.detector.detect(image)
        if faces is None:
            return []
        results = []
        for face in faces[: self.max_faces]:
            if min(face[2], face[3]) < self.min_face_px:
                continue
            landmarks = face[4:14].reshape(5, 2).astype(np.float32)
            matrix, _ = cv2.estimateAffinePartial2D(landmarks, REFERENCE_POINTS, method=cv2.LMEDS)
            if matrix is None:
                continue
            aligned = cv2.warpAffine(image, matrix, (112, 112))
            rgb = cv2.cvtColor(aligned, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
            self.classifier.setInput(cv2.dnn.blobFromImage((rgb - 0.5) / 0.5))
            scores = self.classifier.forward().reshape(-1).astype(np.float64)
            if not (np.all(scores >= 0) and abs(scores.sum() - 1.0) < 1e-3):  # logits -> probabilities
                scores = np.exp(scores - scores.max())
                scores /= scores.sum()
            best = int(np.argmax(scores))
            results.append({"expression": EXPRESSIONS[best], "score": round(float(scores[best]), 3)})
        return results
