#!/usr/bin/env python3
# Copyright (C) 2026 Enrico Miot (EndrX)
# Licensed under GNU GPL v3 or later — see the LICENSE file or <https://www.gnu.org/licenses/>
# SPDX-License-Identifier: GPL-3.0-or-later
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
