#!/usr/bin/env python3
"""Inline the web console into single self-contained files.

No bundler, no dependencies: the sources in web/src are concatenated into

  web/dist/capture.html    a complete standalone page -- open it from disk,
                           works offline, nothing loads from the network
  web/dist/artifact.html   the same page as a body fragment, for hosts that
                           supply their own <head> (Claude Artifacts)

Fonts, styles, catalog data and script all travel inside the file, because a
console a consultant opens in a client's office cannot depend on a CDN.

    python3 tools/build_web.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "web" / "src"
DIST = ROOT / "web" / "dist"

TITLE = "Capture — supply chain AI value realization console"
DESCRIPTION = (
    "Measure how much of a supply chain planning platform a client actually uses, "
    "price the gap, and sequence the fix."
)


def read(name: str) -> str:
    return (SRC / name).read_text(encoding="utf-8")


def guard(source: str, label: str) -> str:
    """Refuse to inline anything that would break out of its own tag."""
    if "</script" in source.lower() or "</style" in source.lower():
        raise SystemExit(f"{label}: contains a closing tag that would break inlining")
    return source


def build() -> tuple[str, str]:
    fonts = read("fonts.css")
    styles = read("styles.css")
    body = read("index.html")
    catalog = guard(read("catalog.data.js"), "catalog.data.js")
    engine = guard(read("engine.js"), "engine.js")
    app = guard(read("app.js"), "app.js")

    css = guard(fonts + "\n" + styles, "css")
    scripts = "\n".join(
        [
            "<script>" + catalog + "</script>",
            "<script>" + engine + "</script>",
            "<script>" + app + "</script>",
        ]
    )

    fragment = "\n".join(
        [
            f"<title>{TITLE}</title>",
            "<style>" + css + "</style>",
            body.rstrip(),
            scripts,
            "",
        ]
    )

    standalone = "\n".join(
        [
            "<!doctype html>",
            '<html lang="en">',
            "<head>",
            '<meta charset="utf-8">',
            '<meta name="viewport" content="width=device-width, initial-scale=1">',
            f"<title>{TITLE}</title>",
            f'<meta name="description" content="{DESCRIPTION}">',
            "<style>" + css + "</style>",
            "</head>",
            "<body>",
            body.rstrip(),
            scripts,
            "</body>",
            "</html>",
            "",
        ]
    )
    return standalone, fragment


def main(check: bool = False) -> int:
    standalone, fragment = build()
    outputs = {DIST / "capture.html": standalone, DIST / "artifact.html": fragment}

    if check:
        stale = [
            path.name
            for path, content in outputs.items()
            if not path.exists() or path.read_text(encoding="utf-8") != content
        ]
        if stale:
            print("stale build output: " + ", ".join(stale), file=sys.stderr)
            print("run: python3 tools/build_web.py", file=sys.stderr)
            return 1
        print("web build is current")
        return 0

    DIST.mkdir(parents=True, exist_ok=True)
    for path, content in outputs.items():
        path.write_text(content, encoding="utf-8")
        print(f"wrote {path} ({path.stat().st_size:,} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(check="--check" in sys.argv))
