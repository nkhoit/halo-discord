#!/usr/bin/env python3
"""Point a generated build/web/halo.html at local development services.

The source shell names the production signaling service and Turnstile site
key.  This rewrites only the generated page, so a local build never contacts
either.  Run it again after every ``ninja web``, which regenerates the page.
"""

from __future__ import annotations

import argparse
import html
import re
import sys
from pathlib import Path


def meta_pattern(name: str) -> re.Pattern[str]:
    return re.compile(
        r'<meta\b(?=[^>]*\bname=(?:["\']%s["\']|%s)(?=[\s>]))[^>]*>' % (name, name)
    )


def configure(page: str, signaling_url: str) -> str:
    signaling = f'<meta name="halo-signaling-url" content="{html.escape(signaling_url)}">'
    page, count = meta_pattern("halo-signaling-url").subn(signaling, page, count=1)
    if count != 1:
        raise ValueError("halo-signaling-url metadata is missing")
    page = meta_pattern("halo-turnstile-sitekey").sub("", page)
    return page


def main() -> int:
    repository = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--page", type=Path, default=repository / "build" / "web" / "halo.html"
    )
    parser.add_argument("--signaling", default="http://127.0.0.1:8787")
    arguments = parser.parse_args()

    page = arguments.page.read_text(encoding="utf-8")
    arguments.page.write_text(configure(page, arguments.signaling), encoding="utf-8")
    print(f"{arguments.page}: signaling {arguments.signaling}, Turnstile off")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        sys.exit(f"web_local_config.py: error: {error}")
