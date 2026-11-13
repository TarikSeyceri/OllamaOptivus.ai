"""Test double for the legacy analysis subprocess (src/processor.py).

The test harness puts this directory on PYTHONPATH. Python imports `sitecustomize` at start-up, so when
the API spawns `python .../processor.py <video> <language>` this module answers instead of the real
processor: it prints a canned v1 analysis JSON and exits before any heavy ML import runs. Every other
Python invocation is left untouched.

Environment variables:
  OPTIVUS_FAKE_ANALYSIS_DIR      directory with per-video fixtures named <video-basename>.json
  OPTIVUS_FAKE_ANALYSIS_DEFAULT  fixture used when no per-video file exists
  OPTIVUS_FAKE_PROCESSOR_MODE    "ok" (default) or "fail" (exit 1 with a message on stderr)
  OPTIVUS_FAKE_PROCESSOR_LOG     if set, one line per invocation is appended (used to count runs)
"""

import os
import sys


def _main() -> None:
    if not sys.argv or not os.path.basename(sys.argv[0]).startswith("processor"):
        return

    video = sys.argv[1] if len(sys.argv) > 1 else ""
    language = sys.argv[2] if len(sys.argv) > 2 else ""

    log_path = os.environ.get("OPTIVUS_FAKE_PROCESSOR_LOG")
    if log_path:
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(f"{video}\t{language}\n")

    if os.environ.get("OPTIVUS_FAKE_PROCESSOR_MODE", "ok") == "fail":
        sys.stderr.write("fake processor failure\n")
        sys.stderr.flush()
        os._exit(1)

    name = os.path.splitext(os.path.basename(video))[0]
    fixtures_dir = os.environ.get("OPTIVUS_FAKE_ANALYSIS_DIR", "")
    candidate = os.path.join(fixtures_dir, name + ".json") if fixtures_dir else ""
    path = candidate if candidate and os.path.isfile(candidate) else os.environ["OPTIVUS_FAKE_ANALYSIS_DEFAULT"]

    with open(path, encoding="utf-8") as fixture:
        sys.stdout.write(fixture.read())
    sys.stdout.flush()
    os._exit(0)


_main()
