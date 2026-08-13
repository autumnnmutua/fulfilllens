from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIREMENTS = ROOT / "apps" / "api" / "requirements-dev.txt"


def main() -> int:
    """Audit the locked project environment without including unrelated global tools."""

    environment = os.environ.copy()
    # pip-api decodes `pip --version` as UTF-8. Force the child interpreter to
    # emit UTF-8 so Windows user profiles containing Chinese characters work.
    environment["PYTHONIOENCODING"] = "utf-8"
    completed = subprocess.run(
        [sys.executable, "-m", "pip_audit", "-r", str(REQUIREMENTS)],
        cwd=ROOT,
        env=environment,
        check=False,
    )
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
