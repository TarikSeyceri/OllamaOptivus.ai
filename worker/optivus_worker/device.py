"""Compute device selection (CUDA, Apple MPS or CPU) and GPU memory helpers."""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

log = logging.getLogger(__name__)


@dataclass
class Device:
    kind: str  # "cuda" | "mps" | "cpu"
    name: str = "CPU"
    index: int = 0
    capability: tuple[int, int] | None = None
    total_memory: int | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def torch_device(self) -> str:
        return f"cuda:{self.index}" if self.kind == "cuda" else self.kind

    def describe(self) -> dict:
        return {
            "kind": self.kind,
            "name": self.name,
            "capability": ".".join(map(str, self.capability)) if self.capability else None,
            "totalMemoryGb": round(self.total_memory / 1024**3, 2) if self.total_memory else None,
        }


def gpu_supported(capability: tuple[int, int], arch_list: list[str]) -> bool:
    """Whether a PyTorch build can run on a GPU of `capability`, following CUDA's compatibility rules.

    Kernels compiled for sm_XY run on GPUs of the same major version X with minor version >= Y (an
    sm_86 build runs on an sm_89 RTX 40xx), and PTX (compute_XY) is JIT-compiled for any newer GPU.
    """
    major, minor = capability
    for arch in arch_list:
        kind, _, number = arch.partition("_")
        if not number.isdigit() or len(number) < 2:
            continue  # e.g. "sm_90a" (architecture-specific features only)
        arch_major, arch_minor = int(number[:-1]), int(number[-1])
        if kind == "sm" and arch_major == major and arch_minor <= minor:
            return True
        if kind == "compute" and (arch_major, arch_minor) <= (major, minor):
            return True
    return not arch_list  # unknown build: let CUDA decide


def select_device(preference: str) -> Device:
    """Picks the best available device. With "auto", an unusable GPU falls back to the CPU."""
    import torch

    if preference in ("auto", "cuda"):
        if torch.cuda.is_available():
            index = torch.cuda.current_device()
            capability = torch.cuda.get_device_capability(index)
            name = torch.cuda.get_device_name(index)
            # A wheel without kernels for this GPU fails later with "no kernel image is available".
            arch = f"sm_{capability[0]}{capability[1]}"
            supported = torch.cuda.get_arch_list()
            if not gpu_supported(capability, supported):
                message = (
                    f"{name} ({arch}) is not supported by this PyTorch build ({', '.join(supported)}). "
                    "Rebuild the worker image with TORCH_VARIANT=cu126 for older GPUs or cu129 for RTX 50xx."
                )
                if preference == "cuda":
                    raise RuntimeError(message)
                log.warning("%s Falling back to CPU.", message)
            else:
                total = torch.cuda.get_device_properties(index).total_memory
                return Device("cuda", name, index, capability, total)
        elif preference == "cuda":
            raise RuntimeError("PROCESSING_DEVICE=cuda but no CUDA GPU is visible (NVIDIA driver / container toolkit?).")

    if preference in ("auto", "mps") and getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return Device("mps", "Apple GPU (MPS)")
    if preference == "mps":
        raise RuntimeError("PROCESSING_DEVICE=mps but Apple MPS is not available.")
    return Device("cpu")


def free_gpu_memory(device: Device) -> int | None:
    if device.kind != "cuda":
        return None
    import torch

    free, _total = torch.cuda.mem_get_info(device.index)
    return free


def wait_for_gpu_memory(device: Device, needed_bytes: int, timeout_s: float = 30.0) -> int | None:
    """Waits (briefly) until another process (e.g. Ollama unloading a model) has freed enough VRAM."""
    if device.kind != "cuda":
        return None
    deadline = time.monotonic() + timeout_s
    free = free_gpu_memory(device)
    while free is not None and free < needed_bytes and time.monotonic() < deadline:
        time.sleep(0.5)
        free = free_gpu_memory(device)
    if free is not None and free < needed_bytes:
        log.warning("Only %.1f GB of GPU memory is free (wanted %.1f GB); continuing.", free / 1024**3, needed_bytes / 1024**3)
    return free


def release_cached_memory(device: Device) -> None:
    if device.kind == "cuda":
        import torch

        torch.cuda.empty_cache()
