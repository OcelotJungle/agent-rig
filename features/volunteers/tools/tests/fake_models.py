"""Fake `volunteer-models.py refresh`: writes refresh-payload.json (next to this file's copy) to --cache.

FAKE_REFRESH_DIR holds refresh-payload.json; the script drops refresh-ran there when it is done.
"""
import os
import shutil
import sys
from pathlib import Path


def main():
    args = sys.argv[1:]
    cache = Path(args[args.index("--cache") + 1])
    base = Path(os.environ["FAKE_REFRESH_DIR"])
    cache.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(base / "refresh-payload.json", cache)
    (base / "refresh-ran").write_text(" ".join(args), encoding="utf-8")


if __name__ == "__main__":
    main()
