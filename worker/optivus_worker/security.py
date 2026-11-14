"""Authentication and path containment."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
from collections.abc import Callable
from pathlib import Path

from fastapi import Header, HTTPException

from .errors import AnalysisError

KEYFRAMES_DIR = re.compile(r"^frames/[A-Za-z0-9_.-]{1,200}$")


def bearer_auth(tokens: list[str]) -> Callable[..., None]:
    """FastAPI dependency: constant-time bearer-token check against every configured token."""
    digests = [hashlib.sha256(t.encode()).digest() for t in tokens]

    def check(authorization: str | None = Header(default=None)) -> None:
        if not digests:  # development without a token
            return
        if authorization and authorization[:7].lower() == "bearer ":
            candidate = hashlib.sha256(authorization[7:].strip().encode()).digest()
            valid = False
            for digest in digests:
                valid = hmac.compare_digest(candidate, digest) or valid
            if valid:
                return
        raise HTTPException(status_code=401, detail="Unauthorized", headers={"WWW-Authenticate": "Bearer"})

    return check


def _inside(path: str, base: str) -> bool:
    try:
        return os.path.commonpath([path, base]) == base
    except ValueError:  # different drives on Windows
        return False


def resolve_video(roots: dict[str, Path], root: str, rel_path: str) -> Path:
    """Resolves `rel_path` inside the named root and refuses escapes.

    Checked twice, like the API: lexically first (so "outside the root" is reported even for files
    that do not exist, without probing the filesystem), then after resolving symlinks.
    """
    base = roots.get(root)
    if base is None:
        raise AnalysisError("PATH_NOT_ALLOWED", f'Unknown storage root "{root}".')
    rel = rel_path.replace("\\", "/")
    if (rel.startswith("/") or os.path.isabs(rel) or re.match(r"^[A-Za-z]:", rel)) and root != "filesystem":
        raise AnalysisError("PATH_NOT_ALLOWED", "Absolute paths are not allowed.")

    base_abs = os.path.abspath(base)
    base_real = str(Path(base).resolve())
    lexical = os.path.normpath(os.path.join(base_abs, rel))
    if not (_inside(lexical, base_abs) or _inside(lexical, base_real)):
        raise AnalysisError("PATH_NOT_ALLOWED", "Video file path not allowed.")
    try:
        real = Path(lexical).resolve(strict=True)
    except OSError as error:
        raise AnalysisError("NOT_FOUND", "Video file not found.") from error
    if not _inside(str(real), base_real):
        raise AnalysisError("PATH_NOT_ALLOWED", "Video file path not allowed.")
    if not real.is_file():
        raise AnalysisError("NOT_FOUND", "Video file not found.")
    return real


def resolve_keyframes_dir(data_dir: Path, rel: str | None) -> Path | None:
    """Keyframes may only be written to data/frames/<name>."""
    if rel is None:
        return None
    if not KEYFRAMES_DIR.match(rel) or ".." in rel:
        raise AnalysisError("PATH_NOT_ALLOWED", "Invalid keyframes directory.")
    return data_dir / rel
