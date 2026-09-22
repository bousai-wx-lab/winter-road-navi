#!/usr/bin/env python3
"""Verify the complete public calendar, grid, numeric runs and file inventory."""

from __future__ import annotations

import argparse
from datetime import date, timedelta
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import zlib


ROOT = Path(__file__).resolve().parents[1]
DAYS = [(date(2000, 1, 1) + timedelta(days=i)).strftime("%m-%d") for i in range(366)]
CELL_COUNT = 387717
MISSING_COUNT = 4220
MAX_JSON_BYTES = 16_000_000
MAX_DAILY_JSON_BYTES = 2_000_000
ROAD_CLASSES = [
    {"id": 0, "meaning": "missing"},
    {"id": 1, "lower_exclusive_c": 5, "upper_inclusive_c": None, "color": "original"},
    {"id": 2, "lower_exclusive_c": 2, "upper_inclusive_c": 5, "color": "yellow"},
    {"id": 3, "lower_exclusive_c": 0, "upper_inclusive_c": 2, "color": "orange"},
    {"id": 4, "lower_exclusive_c": None, "upper_inclusive_c": 0, "color": "red"},
]
# A 1 C mesh color cannot resolve an exact 0/2/5 C threshold. Both road
# classes are possible only within the three corresponding boundary bins.
ROAD_CLASSES_BY_BIN = tuple(
    (0,) if b == 0 else (4,) if b <= 40 else (3, 4) if b == 41 else
    (3,) if b == 42 else (2, 3) if b == 43 else (2,) if b <= 45 else
    (1, 2) if b == 46 else (1,) for b in range(82)
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def integer(value):
    return type(value) is int


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON field")
        result[key] = value
    return result


def read_json(path):
    require(path.is_file() and not path.is_symlink(), "missing or linked JSON file")
    require(path.stat().st_size <= MAX_JSON_BYTES, "JSON exceeds inspection bound")
    raw = path.read_bytes()
    value = json.loads(raw, object_pairs_hook=unique_object)
    require(type(value) is dict, "JSON root must be an object")
    return raw, value


def decode_temperature_gzip(data, expected_raw_bytes):
    require(integer(expected_raw_bytes) and 0 < expected_raw_bytes <= MAX_DAILY_JSON_BYTES, "invalid expanded byte count")
    require(len(data) <= MAX_DAILY_JSON_BYTES and data[:4] == b"\x1f\x8b\x08\x00" and data[4:8] == bytes(4), "invalid daily gzip header")
    try:
        decoder = zlib.decompressobj(31)
        raw = decoder.decompress(data, MAX_DAILY_JSON_BYTES + 1)
        require(len(raw) <= MAX_DAILY_JSON_BYTES and decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail, "daily gzip truncated, trailing or too large")
        require(len(raw) == expected_raw_bytes, "expanded byte count mismatch")
        value = json.loads(raw, object_pairs_hook=unique_object)
    except zlib.error as exc:
        raise ValueError("invalid daily gzip stream") from exc
    require(type(value) is dict, "daily JSON root must be an object")
    return value


def validate_temperature_gzip(path_label, data, record, *, allow_legacy_mesh_only=False):
    match = re.fullmatch(r"data/temperature/(\d{2}-\d{2})\.json\.gz", path_label)
    require(match is not None and match[1] in DAYS, "invalid daily gzip path")
    value = decode_temperature_gzip(data, record.get("uncompressed_bytes"))
    validate_day(value, match[1], CELL_COUNT, MISSING_COUNT, require_road=not allow_legacy_mesh_only)


def validate_metadata(value):
    if value is None or type(value) in (str, bool, int):
        return
    if type(value) is float:
        require(math.isfinite(value), "nonfinite metadata number")
        return
    if type(value) is list:
        for item in value:
            validate_metadata(item)
        return
    require(type(value) is dict, "invalid metadata type")
    for key, item in value.items():
        require(type(key) is str and bool(key), "invalid metadata key")
        validate_metadata(item)


def public_file(entry, manifest_path, root):
    require(type(entry) is dict, "file record must be an object")
    url = entry.get("url")
    require(type(url) is str and bool(re.fullmatch(r"(?:\./)?[A-Za-z0-9_./-]+", url)), "invalid asset URL")
    relative = PurePosixPath(url.removeprefix("./"))
    require(not relative.is_absolute() and all(part not in (".", "..") for part in relative.parts), "unsafe asset URL")
    require(integer(entry.get("bytes")) and 0 < entry["bytes"] <= MAX_JSON_BYTES, "invalid asset byte count")
    require(type(entry.get("sha256")) is str and bool(re.fullmatch(r"[0-9a-f]{64}", entry["sha256"])), "invalid asset digest")
    candidates = {manifest_path.parent / relative, root / relative}
    candidates = [p for p in candidates if p.is_file()]
    require(len(candidates) == 1, "asset URL missing or ambiguous")
    path = candidates[0]
    require(path.resolve().is_relative_to(manifest_path.parent.resolve()), "asset URL leaves data directory")
    require(not path.is_symlink() and path.stat().st_size <= MAX_JSON_BYTES, "linked or oversized asset")
    raw = path.read_bytes()
    require(len(raw) == entry["bytes"], "asset byte count mismatch")
    require(hashlib.sha256(raw).hexdigest() == entry["sha256"], "asset digest mismatch")
    if path.suffix == ".gz":
        value = decode_temperature_gzip(raw, entry.get("uncompressed_bytes"))
    else:
        value = json.loads(raw, object_pairs_hook=unique_object)
        require(type(value) is dict, "asset JSON root must be an object")
    return path, value


def validate_grid(grid, count):
    require(set(grid) == {"cell_count", "runs"}, "unexpected grid fields")
    require(integer(grid["cell_count"]) and grid["cell_count"] == count, "grid cell count mismatch")
    runs = grid["runs"]
    require(type(runs) is list and bool(runs) and len(runs) % 3 == 0, "invalid grid runs")
    total, previous_row, previous_end = 0, None, None
    for i in range(0, len(runs), 3):
        row, column, length = runs[i:i+3]
        require(all(integer(v) for v in (row, column, length)), "grid run values must be integers")
        require(-10800 <= row < 10800 and -14400 <= column < 14400 and 0 < length <= count, "grid coordinate or length outside range")
        require(column + length <= 14400, "grid longitude range overflow")
        require(previous_row is None or row > previous_row or (row == previous_row and column >= previous_end), "grid ranges duplicate or unordered")
        total += length
        require(total <= count, "grid runs exceed cell count")
        previous_row, previous_end = row, column + length
    require(total == count, "grid runs do not cover cell count")


def validate_day(value, day, count, missing_count, *, require_road=True):
    expected_fields = {"day", "cell_count", "runs", "road_runs"}
    legacy_mesh_only = not require_road and set(value) == {"day", "cell_count", "runs"}
    require(legacy_mesh_only or set(value) == expected_fields, "unexpected daily fields")
    require(value["day"] == day, "daily calendar key mismatch")
    require(integer(value["cell_count"]) and value["cell_count"] == count, "daily cell count mismatch")
    runs = value["runs"]
    require(type(runs) is list and bool(runs) and len(runs) % 2 == 0, "invalid daily runs")
    total, missing = 0, 0
    for i in range(0, len(runs), 2):
        color_bin, length = runs[i:i+2]
        require(integer(color_bin) and 0 <= color_bin <= 81, "invalid temperature bin")
        require(integer(length) and 0 < length <= count, "invalid daily run length")
        total += length
        require(total <= count, "daily runs exceed cell count")
        if color_bin == 0:
            missing += length
    require(total == count, "daily runs do not cover cell count")
    require(missing == missing_count, "daily missing count mismatch")
    if legacy_mesh_only:
        return
    road_runs = value["road_runs"]
    require(type(road_runs) is list and bool(road_runs) and len(road_runs) % 2 == 0, "invalid road runs")
    total, missing = 0, 0
    for i in range(0, len(road_runs), 2):
        road_class, length = road_runs[i:i+2]
        require(integer(road_class) and 0 <= road_class <= 4, "invalid road class")
        require(integer(length) and 0 < length <= count, "invalid road run length")
        total += length
        require(total <= count, "road runs exceed cell count")
        if road_class == 0:
            missing += length
    require(total == count, "road runs do not cover cell count")
    require(missing == missing_count, "road missing count mismatch")
    i, j, left, right = 0, 0, runs[1], road_runs[1]
    while i < len(runs) and j < len(road_runs):
        require(road_runs[j] in ROAD_CLASSES_BY_BIN[runs[i]], "road class/temperature bin or missing position mismatch")
        consumed = min(left, right)
        left, right = left - consumed, right - consumed
        if left == 0:
            i += 2
            if i < len(runs):
                left = runs[i+1]
        if right == 0:
            j += 2
            if j < len(road_runs):
                right = road_runs[j+1]
    require(i == len(runs) and j == len(road_runs), "road/temperature coverage mismatch")


def verify(manifest_path, *, root=ROOT, expected_count=CELL_COUNT, expected_missing=MISSING_COUNT, expected_days=DAYS):
    manifest_path, root = Path(manifest_path).resolve(), Path(root).resolve()
    require(manifest_path.is_relative_to(root), "manifest is outside release root")
    _, manifest = read_json(manifest_path)
    validate_metadata(manifest)
    expected = {"schema_version": 1, "cell_count": expected_count, "bin_min": -40,
                "bin_step": 1, "bin_count": 81, "missing_bin": 0}
    for key, value in expected.items():
        require(integer(manifest.get(key)) and manifest[key] == value, "invalid manifest " + key)
    require(manifest.get("days") == list(expected_days), "manifest calendar incomplete or unordered")
    require(type(manifest.get("source_id")) is str and bool(manifest["source_id"].strip()), "source identity missing")
    require(json.dumps(manifest.get("road_classes"), sort_keys=True) == json.dumps(ROAD_CLASSES, sort_keys=True),
            "invalid road class definitions")
    for key in ("source_snapshot_id", "generated_at_utc", "unit", "baseline", "attribution", "method"):
        if key in manifest:
            require(type(manifest[key]) is str and bool(manifest[key].strip()), "invalid public metadata " + key)
    for key in ("source_sha256", "source_snapshot_hash"):
        if key in manifest:
            require(type(manifest[key]) is str and bool(re.fullmatch(r"[0-9a-f]{64}", manifest[key])), "invalid source digest")
    for key in ("source_urls", "terms_urls", "limitations"):
        if key in manifest:
            require(type(manifest[key]) is list and bool(manifest[key]) and all(type(item) is str and bool(item.strip()) for item in manifest[key]), "invalid public metadata " + key)
    grid_path, grid = public_file(manifest.get("grid"), manifest_path, root)
    validate_grid(grid, expected_count)
    files = manifest.get("files")
    require(type(files) is list and len(files) == len(expected_days), "daily inventory incomplete")
    require(all(type(e) is dict for e in files), "invalid daily inventory record")
    require([e.get("day") for e in files] == list(expected_days), "daily inventory duplicate or unordered")
    expected_files = {manifest_path, grid_path}
    for day, entry in zip(expected_days, files):
        path, value = public_file(entry, manifest_path, root)
        require(path.name == day + ".json.gz", "daily file name mismatch")
        require(path not in expected_files, "duplicate asset URL")
        expected_files.add(path)
        validate_day(value, day, expected_count, expected_missing)
    actual_files = set()
    for path in manifest_path.parent.rglob("*"):
        require(not path.is_symlink(), "linked entry in data directory")
        if path.is_file():
            actual_files.add(path)
    require(actual_files == expected_files, "data file inventory mismatch")
    return {"days": len(expected_days), "grid_cells": expected_count,
            "missing_cells_per_day": expected_missing, "files": len(expected_files)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, default=ROOT / "data/temperature/manifest.json")
    args = parser.parse_args()
    try:
        result = verify(args.manifest)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SystemExit("TEMPERATURE_DISPLAY_REJECTED: " + str(exc)) from None
    print("TEMPERATURE_DISPLAY_VERIFY_OK " + json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
