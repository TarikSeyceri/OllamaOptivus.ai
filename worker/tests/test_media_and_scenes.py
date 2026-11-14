from __future__ import annotations

import os
import threading

import numpy as np
import pytest
from conftest import FIXTURES

from optivus_worker.errors import AnalysisError, Cancelled
from optivus_worker.media import probe, sample_frames
from optivus_worker.scenes import SceneDetector, changed
from optivus_worker.security import resolve_keyframes_dir, resolve_video


def test_probe():
    speech = probe(FIXTURES / "speech.mp4")
    assert (speech.width, speech.height, speech.has_audio) == (640, 360, True)
    assert 13.9 < speech.duration < 14.1
    assert probe(FIXTURES / "silent.mp4").has_audio is False


def test_probe_rejects_non_videos(tmp_path):
    fake = tmp_path / "fake.mp4"
    fake.write_bytes(b"not a video at all")
    with pytest.raises(AnalysisError) as error:
        probe(fake)
    assert error.value.code == "INVALID_VIDEO"


def test_sampling_is_time_based_and_monotonic():
    one = list(sample_frames(FIXTURES / "speech.mp4", 1.0, 1280))
    two = list(sample_frames(FIXTURES / "speech.mp4", 2.0, 1280))
    assert len(one) == 14
    assert 27 <= len(two) <= 28
    times = [t for t, _ in two]
    assert times == sorted(times) and len(set(times)) == len(times)
    assert one[0][1].shape == (360, 640, 3)


def test_sampling_faster_than_the_video_never_loops():
    frames = list(sample_frames(FIXTURES / "silent.mp4", 30.0, 1280))  # the clip has 15 fps
    assert len(frames) == 75


def test_downscaling_and_rotation():
    small = next(sample_frames(FIXTURES / "speech.mp4", 1.0, 320))[1]
    assert small.shape == (180, 320, 3)
    upright = next(sample_frames(FIXTURES / "rotated.mp4", 1.0, 1280))[1]
    assert upright.shape == (320, 240, 3), "portrait phone video must be rotated upright"


def test_sampling_can_be_cancelled():
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(Cancelled):
        next(sample_frames(FIXTURES / "speech.mp4", 1.0, 1280, cancel))


def test_scene_detector():
    detector = SceneDetector(0.7)
    blue = np.zeros((90, 160, 3), np.uint8)
    blue[:] = (200, 60, 20)
    red = np.zeros((90, 160, 3), np.uint8)
    red[:] = (20, 40, 220)
    noisy_blue = np.clip(blue.astype(int) + np.random.default_rng(1).integers(-6, 6, blue.shape), 0, 255).astype(np.uint8)
    assert detector.observe(blue)[0] is True  # first frame starts a scene
    assert detector.observe(noisy_blue)[0] is False
    assert detector.observe(red)[0] is True


def test_change_detection():
    a = np.zeros((90, 160), np.uint8)
    b = a.copy()
    b[:10, :10] = 255  # 0.7% of the pixels
    c = a.copy()
    c[:30, :30] = 255  # 6% of the pixels
    assert changed(None, a, 0.01) is True
    assert changed(a, b, 0.01) is False
    assert changed(a, c, 0.01) is True


def test_video_paths_stay_inside_their_root(tmp_path):
    videos = tmp_path / "videos"
    videos.mkdir()
    (videos / "a.mp4").write_bytes(b"x")
    (tmp_path / "secret.mp4").write_bytes(b"x")
    roots = {"videos": videos}
    assert resolve_video(roots, "videos", "a.mp4") == (videos / "a.mp4").resolve()
    for path in ("../secret.mp4", str(tmp_path / "secret.mp4"), "a.mp4/../../secret.mp4"):
        with pytest.raises(AnalysisError) as error:
            resolve_video(roots, "videos", path)
        assert error.value.code == "PATH_NOT_ALLOWED", path
    with pytest.raises(AnalysisError):
        resolve_video(roots, "nas", "a.mp4")


def test_symlinks_cannot_escape(tmp_path):
    videos = tmp_path / "videos"
    videos.mkdir()
    (tmp_path / "secret.mp4").write_bytes(b"x")
    try:
        os.symlink(tmp_path / "secret.mp4", videos / "link.mp4")
    except OSError:
        pytest.skip("symlinks are not permitted here")
    with pytest.raises(AnalysisError) as error:
        resolve_video({"videos": videos}, "videos", "link.mp4")
    assert error.value.code == "PATH_NOT_ALLOWED"


def test_keyframe_directories(tmp_path):
    assert resolve_keyframes_dir(tmp_path, None) is None
    assert resolve_keyframes_dir(tmp_path, "frames/abc.123") == tmp_path / "frames/abc.123"
    for bad in ("frames/../x", "../frames/x", "videos/x", "frames/a/b"):
        with pytest.raises(AnalysisError):
            resolve_keyframes_dir(tmp_path, bad)


def test_gpu_compatibility_rules():
    from optivus_worker.device import gpu_supported

    cu126 = ["sm_50", "sm_60", "sm_70", "sm_75", "sm_80", "sm_86", "sm_90"]
    assert gpu_supported((8, 9), cu126), "RTX 40xx (sm_89) runs sm_86 kernels"
    assert gpu_supported((8, 6), cu126)
    assert not gpu_supported((12, 0), cu126), "RTX 50xx needs a build with sm_120 or PTX"
    assert gpu_supported((12, 0), [*cu126, "compute_90"]), "PTX is JIT-compiled for newer GPUs"
    assert not gpu_supported((6, 1), ["sm_75", "sm_80", "sm_86"]), "Pascal is not in CUDA 12.8+ builds"
    assert gpu_supported((7, 5), [])
