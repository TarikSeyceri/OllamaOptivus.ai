"""Errors that are reported to the API as `{"type": "error", "code": ..., "message": ...}`."""


class AnalysisError(Exception):
    """An expected failure with a stable, machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class Cancelled(Exception):
    """The client disconnected or cancelled the analysis."""
