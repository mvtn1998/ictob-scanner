"""Fresh F&O universe for a container with no disk persistence.

A deployed copy starts empty, so the engine needs the broker's instrument
master without shipping the 70 MB file. This streams the gzipped master
(`complete.json.gz`), keeps only the rows the scanner can use — NSE cash
equities, NSE indices and stock futures — and writes a compact
`data/instruments_cache.json` that `build_universe` already understands.

`ijson` streams the array, so peak memory stays a few megabytes.
"""
from __future__ import annotations

import gzip
import json
import os
import time
from pathlib import Path

import ijson
import requests

MASTER_URL = ("https://assets.upstox.com/market-quote/instruments/"
              "exchange/complete.json.gz")
UA = {"User-Agent": "ob-sentinel/1.0"}
KEEP = ("NSE_EQ", "NSE_INDEX", "NSE_FO")


def _wanted(row: dict) -> bool:
    seg = row.get("segment")
    if seg not in KEEP:
        return False
    if seg == "NSE_EQ":
        return row.get("instrument_type") == "EQ"
    if seg == "NSE_FO":
        return row.get("instrument_type") == "FUT"
    return True


def refresh_master(data_dir: Path, max_age_hours: float = 20.0) -> bool:
    """Download and trim the instrument master. True when the file changed."""
    dest = Path(data_dir) / "instruments_cache.json"
    if dest.exists():
        age = (time.time() - dest.stat().st_mtime) / 3600.0
        if age < max_age_hours:
            return False

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".json.tmp")
    rows: list[dict] = []
    with requests.get(MASTER_URL, headers=UA, stream=True, timeout=180) as r:
        r.raise_for_status()
        with gzip.GzipFile(fileobj=r.raw) as gz:
            for row in ijson.items(gz, "item"):
                if isinstance(row, dict) and _wanted(row):
                    rows.append(row)
    if not rows:
        raise RuntimeError("instrument master was empty")
    tmp.write_text(json.dumps(rows, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, dest)
    return True
