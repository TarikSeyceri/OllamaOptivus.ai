"""Entry point: `python -m optivus_worker` (validates the configuration, then serves with uvicorn)."""

from __future__ import annotations

import json
import logging
import sys

import uvicorn

from .config import Settings


class JsonFormatter(logging.Formatter):
    """One JSON object per line, like the API's pino logs."""

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "time": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname.lower(),
            "service": "optivus-worker",
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            entry["err"] = self.formatException(record.exc_info)
        return json.dumps(entry, ensure_ascii=False)


def main() -> None:
    settings = Settings()
    problems = settings.problems()
    if problems:
        print("Invalid configuration - refusing to start:\n" + "\n".join(f"  - {p}" for p in problems), file=sys.stderr)
        sys.exit(2)

    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s") if settings.is_development else JsonFormatter()
    )
    logging.basicConfig(level=settings.log_level, handlers=[handler], force=True)

    uvicorn.run(
        "optivus_worker.main:create_app",
        factory=True,
        host=settings.worker_host,
        port=settings.worker_port,
        workers=1,  # one process per GPU; models live in memory
        log_level=settings.log_level.lower(),
        log_config=None,  # keep the logging set up above
        access_log=settings.is_development,
        server_header=False,
        date_header=False,
        proxy_headers=False,
        timeout_keep_alive=30,
    )


if __name__ == "__main__":
    main()
