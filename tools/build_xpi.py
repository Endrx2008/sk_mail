#!/usr/bin/env python3
"""python3 tools/build_xpi.py [outdir] -> skai-thunderbird.xpi (a zip of xpi/)"""
import sys, zipfile
from pathlib import Path
root = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1] if len(sys.argv) > 1 else root / "dist"); out.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(out / "skai-thunderbird.xpi", "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted((root / "xpi").rglob("*")):
        if f.is_file():
            z.write(f, f.relative_to(root / "xpi").as_posix())
print("built", out / "skai-thunderbird.xpi")
