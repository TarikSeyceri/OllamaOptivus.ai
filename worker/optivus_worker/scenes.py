"""Scene cuts and frame changes on tiny downscaled frames (a few microseconds per frame, CPU).

- Scene cut: the colour histogram (HSV, hue x saturation) correlates less than `cut_threshold`
  with the histogram of the current scene's first frame. Comparing against the scene start (not
  just the previous frame) also catches slow fades. 0.7 is the threshold the v1 dev branch used.
- Change: the share of pixels whose brightness changed noticeably. Used to skip OCR on frames
  that look the same as the last frame that was read.
"""

from __future__ import annotations

import cv2
import numpy as np

_SMALL = (160, 90)


class SceneDetector:
    def __init__(self, cut_threshold: float = 0.7) -> None:
        self.cut_threshold = cut_threshold
        self._scene_hist: np.ndarray | None = None

    def observe(self, image: np.ndarray) -> tuple[bool, np.ndarray]:
        """Returns (is_scene_cut, small_grayscale) for the next sampled frame."""
        small = cv2.resize(image, _SMALL, interpolation=cv2.INTER_AREA)
        hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [32, 32], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        if self._scene_hist is None:
            self._scene_hist = hist
            return True, gray
        cut = cv2.compareHist(self._scene_hist, hist, cv2.HISTCMP_CORREL) < self.cut_threshold
        if cut:
            self._scene_hist = hist
        return bool(cut), gray


def changed(previous: np.ndarray | None, current: np.ndarray, ratio: float, pixel_delta: int = 25) -> bool:
    """True when more than `ratio` of the pixels differ by more than `pixel_delta` grey levels."""
    if previous is None:
        return True
    diff = cv2.absdiff(previous, current)
    return float(np.count_nonzero(diff > pixel_delta)) / diff.size > ratio
