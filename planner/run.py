from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from vmax_planner.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
