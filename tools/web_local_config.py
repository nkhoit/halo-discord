#!/usr/bin/env python3
"""Point a generated build/web/halo.html at local development services.

The source shell names no signaling service or Turnstile site key; this
writes the local signaling service into the generated page (and drops a site
key if one is there).  Run it again after every ``ninja web``, which
regenerates the page.
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


def configure(page: str, signaling_url: str, relay_url: str | None = None) -> str:
    signaling = f'<meta name="halo-signaling-url" content="{html.escape(signaling_url)}">'
    if relay_url:
        signaling += f'<meta name="halo-relay-url" content="{html.escape(relay_url)}">'
    page = meta_pattern("halo-relay-url").sub("", page)
    page, count = meta_pattern("halo-signaling-url").subn(signaling, page, count=1)
    if count != 1:
        page, count = meta_pattern("halo-build-id").subn(
            lambda match: match.group(0) + signaling, page, count=1)
    if count != 1:
        raise ValueError("halo-build-id metadata is missing")
    page = meta_pattern("halo-turnstile-sitekey").sub("", page)
    return page


def main() -> int:
    repository = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--page", type=Path, default=repository / "build" / "web" / "halo.html"
    )
    parser.add_argument("--signaling", default="http://127.0.0.1:8787")
    parser.add_argument(
        "--relay", help="WebSocket relay for ?transport=relay (the server/ origin)"
    )
    arguments = parser.parse_args()

    page = arguments.page.read_text(encoding="utf-8")
    arguments.page.write_text(
        configure(page, arguments.signaling, arguments.relay), encoding="utf-8"
    )
    relay = f", relay {arguments.relay}" if arguments.relay else ""
    print(f"{arguments.page}: signaling {arguments.signaling}{relay}, Turnstile off")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError) as error:
        sys.exit(f"web_local_config.py: error: {error}")
