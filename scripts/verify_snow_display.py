#!/usr/bin/env python3
"""Independently verify the winter-only snow display inventory and contours."""
from __future__ import annotations

from datetime import date, timedelta
import hashlib
import json
from pathlib import Path
import re
import zlib


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "data/snow/manifest.json"
DAYS = [(date(2000, 1, 1) + timedelta(days=i)).strftime("%m-%d") for i in range(366)]
SEASON = DAYS[DAYS.index("09-15"):] + DAYS[:DAYS.index("06-15") + 1]
THRESHOLDS = (1, 5, 10, 20, 50, 100)
MAX_DAILY = 4_000_000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def pairs_unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON field")
        result[key] = value
    return result


def decode_snow_gzip(data: bytes, expected_raw_bytes: int):
    require(type(expected_raw_bytes) is int and 0 < expected_raw_bytes <= MAX_DAILY, "invalid snow expanded size")
    require(len(data) <= 500_000 and data[:8] == b"\x1f\x8b\x08\x00\x00\x00\x00\x00", "invalid snow gzip header")
    try:
        decoder = zlib.decompressobj(31)
        raw = decoder.decompress(data, MAX_DAILY + 1)
        require(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail
                and len(raw) == expected_raw_bytes, "invalid snow compressed stream")
        result = json.loads(raw, object_pairs_hook=pairs_unique)
    except zlib.error as exc:
        raise ValueError("invalid snow gzip stream") from exc
    require(type(result) is dict, "snow JSON root is not an object")
    return result


def validate_snow_gzip(path_label: str, data: bytes, record: dict):
    match = re.fullmatch(r"data/snow/(\d{2}-\d{2})\.json\.gz", path_label)
    require(match is not None and match[1] in SEASON, "invalid snow file path")
    value = decode_snow_gzip(data, record.get("uncompressed_bytes"))
    require(set(value) == {"day", "cell_count", "runs", "contours"}
            and value["day"] == match[1] and type(value["cell_count"]) is int
            and value["cell_count"] == 387717, "invalid snow day identity")
    runs = value["runs"]
    require(type(runs) is list and bool(runs) and len(runs) % 2 == 0, "invalid snow runs")
    count = 0
    for index in range(0, len(runs), 2):
        bin_value, length = runs[index:index + 2]
        require(type(bin_value) is int and 0 <= bin_value <= 7
                and type(length) is int and length > 0, "invalid snow class or run length")
        count += length
        require(count <= 387717, "snow runs overflow grid")
    require(count == 387717, "snow runs do not cover grid")
    contours = value["contours"]
    require(type(contours) is dict and set(contours) == {str(level) for level in THRESHOLDS},
            "invalid snow contour levels")
    for level in THRESHOLDS:
        segments = contours[str(level)]
        require(type(segments) is list and len(segments) % 3 == 0 and len(segments) <= 300_000,
                "invalid snow contour count")
        for index in range(0, len(segments), 3):
            row, col, axis = segments[index:index + 3]
            require(type(row) is int and 0 <= row <= 10206
                    and type(col) is int and 0 <= col <= 14400
                    and type(axis) is int and axis in (0, 1), "invalid snow contour coordinate")
    return value


def expand_grid(value):
    require(type(value) is dict and set(value) == {"cell_count", "runs"}
            and value["cell_count"] == 387717 and type(value["runs"]) is list,
            "invalid shared display grid")
    cells = []
    for i in range(0, len(value["runs"]), 3):
        row, first_col, length = value["runs"][i:i + 3]
        require(all(type(x) is int for x in (row, first_col, length)) and length > 0,
                "invalid display grid run")
        cells.extend((row, first_col + offset) for offset in range(length))
    require(len(cells) == 387717 and len(set(cells)) == len(cells), "invalid display grid topology")
    return cells


def expand_bins(value):
    bins = bytearray()
    runs = value["runs"]
    for i in range(0, len(runs), 2):
        bins.extend(bytes([runs[i]]) * runs[i + 1])
    require(len(bins) == 387717, "invalid expanded snow bins")
    return bins


def verify_contours(value, cells, indices):
    bins = expand_bins(value)
    expected = {level: [] for level in THRESHOLDS}
    for index, (row, col) in enumerate(cells):
        for neighbor, axis in ((indices.get((row, col + 1)), 0), (indices.get((row + 1, col)), 1)):
            if neighbor is None or bins[index] == 0 or bins[neighbor] == 0:
                continue
            for level_index, level in enumerate(THRESHOLDS, 2):
                if (bins[index] >= level_index) != (bins[neighbor] >= level_index):
                    expected[level].append((row, col, axis))
    for level in THRESHOLDS:
        saved = value["contours"][str(level)]
        observed = [tuple(saved[i:i + 3]) for i in range(0, len(saved), 3)]
        require(len(set(observed)) == len(observed) and set(observed) == set(expected[level]),
                f"snow {level} cm contour is inconsistent with 1 km bins")


def verify():
    manifest = json.loads(MANIFEST.read_bytes(), object_pairs_hook=pairs_unique)
    require(manifest["schema_version"] == 1 and manifest["source_id"] == "daily-snow-depth-normals-1km"
            and manifest["baseline"] == "1991-2020" and manifest["days"] == SEASON
            and manifest["cell_count"] == 387717 and manifest["missing_bin"] == 0
            and manifest["thresholds_cm"] == list(THRESHOLDS), "invalid snow display manifest")
    grid_bytes = (ROOT / "data/temperature/grid.json").read_bytes()
    require(hashlib.sha256(grid_bytes).hexdigest() == manifest["grid_sha256"],
            "snow and temperature display grids differ")
    files = manifest["files"]
    require(type(files) is list and len(files) == len(SEASON), "incomplete snow file inventory")
    representative = {"09-15", "01-15", "02-29", "05-15", "06-15"}
    cells = expand_grid(json.loads(grid_bytes))
    indices = {cell: i for i, cell in enumerate(cells)}
    total_bytes = 0
    for day, record in zip(SEASON, files):
        require(record["day"] == day and record["url"] == f"{day}.json.gz"
                and type(record["bytes"]) is int and 0 < record["bytes"] <= 500_000
                and type(record["sha256"]) is str and bool(re.fullmatch(r"[0-9a-f]{64}", record["sha256"])),
                "invalid snow file record")
        path = MANIFEST.parent / record["url"]
        require(path.is_file() and not path.is_symlink(), "missing snow display file")
        raw = path.read_bytes()
        require(len(raw) == record["bytes"] and hashlib.sha256(raw).hexdigest() == record["sha256"],
                "snow file bytes/hash mismatch")
        value = validate_snow_gzip(f"data/snow/{day}.json.gz", raw, record)
        if day in representative:
            verify_contours(value, cells, indices)
        total_bytes += len(raw)
    print(f"SNOW_DISPLAY_VERIFY_OK days={len(SEASON)} bytes={total_bytes} representative_contours={len(representative)}")


if __name__ == "__main__":
    verify()
