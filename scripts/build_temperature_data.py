#!/usr/bin/env python3
"""Build the compact browser module for daily minimum-temperature normals.

The source archives are the Japan Meteorological Agency 2020 normals (5th
edition). The browser payload keeps 180 spatially distributed stations and
stores 366 daily values as signed 16-bit integers in 0.1 degree C units.
"""

from __future__ import annotations

import argparse
import base64
import csv
import hashlib
import io
import json
import math
import struct
import tempfile
import urllib.request
import zipfile
from pathlib import Path


DAILY_URL = "https://ds.data.jma.go.jp/obd/stats/data/mdrr/normal/2020/data/normal_amedas_daily.zip"
STATION_URL = "https://ds.data.jma.go.jp/obd/stats/data/mdrr/normal/2020/data/amedas_station_index.zip"
STATION_COUNT = 180
MONTH_LENGTHS = (31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_source(source_dir: Path, filename: str, url: str) -> Path:
    path = source_dir / filename
    if path.exists():
        return path
    source_dir.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=60) as response, path.open("wb") as output:
        output.write(response.read())
    return path


def load_stations(path: Path) -> dict[str, dict[str, object]]:
    with zipfile.ZipFile(path) as archive:
        raw = archive.read("amedas_station_index.csv").decode("cp932")
    rows = csv.reader(io.StringIO(raw))
    next(rows)
    next(rows)
    stations: dict[str, dict[str, object]] = {}
    for row in rows:
        if len(row) < 15 or row[12].strip() != "1":
            continue
        station_id = row[0].strip()
        stations[station_id] = {
            "id": station_id,
            "name": row[3].strip().title(),
            "lat": float(row[4]) + float(row[5]) / 60,
            "lon": float(row[6]) + float(row[7]) / 60,
            "alt": int(row[8]),
        }
    return stations


def load_daily_minima(path: Path, stations: dict[str, dict[str, object]]) -> None:
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if not info.filename.endswith(".csv"):
                continue
            station_id = Path(info.filename).stem.rsplit("_", 1)[-1]
            station = stations.get(station_id)
            if station is None:
                continue
            months: dict[int, list[int]] = {}
            text = io.TextIOWrapper(archive.open(info), encoding="ascii", newline="")
            for row in csv.reader(text):
                if len(row) < 9 or row[2].strip() != "0700":
                    continue
                month = int(row[6])
                values: list[int] = []
                for day in range(MONTH_LENGTHS[month - 1]):
                    value = int(row[7 + day * 2])
                    remark = int(row[8 + day * 2])
                    if remark != 8:
                        values = []
                        break
                    values.append(value)
                if values:
                    months[month] = values
            if len(months) == 12:
                station["values"] = [value for month in range(1, 13) for value in months[month]]


def distance_sq(a: dict[str, object], b: dict[str, object]) -> float:
    mean_lat = math.radians((float(a["lat"]) + float(b["lat"])) / 2)
    dx = (float(a["lon"]) - float(b["lon"])) * math.cos(mean_lat)
    dy = float(a["lat"]) - float(b["lat"])
    return dx * dx + dy * dy


def select_stations(stations: list[dict[str, object]], count: int) -> list[dict[str, object]]:
    """Deterministic farthest-point sample for broad national coverage."""
    if len(stations) < count:
        raise ValueError(f"only {len(stations)} complete stations; {count} requested")
    seed = min(stations, key=lambda item: (float(item["lat"]), float(item["lon"]), str(item["id"])))
    selected = [seed]
    remaining = [station for station in stations if station is not seed]
    nearest = {str(station["id"]): distance_sq(station, seed) for station in remaining}
    while len(selected) < count:
        candidate = max(remaining, key=lambda item: (nearest[str(item["id"])], str(item["id"])))
        selected.append(candidate)
        remaining.remove(candidate)
        for station in remaining:
            key = str(station["id"])
            nearest[key] = min(nearest[key], distance_sq(station, candidate))
    return sorted(selected, key=lambda item: str(item["id"]))


def build_module(selected: list[dict[str, object]], daily_hash: str, station_hash: str) -> str:
    binary = bytearray()
    metadata = []
    for station in selected:
        values = station["values"]
        if len(values) != 366:
            raise ValueError(f"{station['id']} has {len(values)} values")
        binary.extend(struct.pack(f"<{len(values)}h", *values))
        metadata.append({key: station[key] for key in ("id", "name", "lat", "lon", "alt")})
    payload = base64.b64encode(binary).decode("ascii")
    provenance = {
        "publisher": "Japan Meteorological Agency",
        "dataset": "2020 normals (5th edition), AMeDAS daily normals",
        "statistics_period": "1991-2020",
        "element": "daily minimum temperature normal",
        "unit": "0.1 degree C",
        "station_selection": f"deterministic farthest-point sample of {len(selected)} complete temperature stations",
        "daily_source": DAILY_URL,
        "daily_sha256": daily_hash,
        "station_source": STATION_URL,
        "station_sha256": station_hash,
        "terms": "https://www.jma.go.jp/jma/kishou/info/coment.html",
        "modified_by": "Bousai Wx Lab",
    }
    return (
        "// Generated by scripts/build_temperature_data.py from public JMA normals.\n"
        f"export const TEMPERATURE_PROVENANCE = Object.freeze({json.dumps(provenance, ensure_ascii=False, separators=(',', ':'))});\n"
        f"export const TEMPERATURE_STATIONS = Object.freeze({json.dumps(metadata, ensure_ascii=False, separators=(',', ':'))});\n"
        f"export const TEMPERATURE_VALUES_BASE64 = \"{payload}\";\n"
        "export const TEMPERATURE_DAY_COUNT = 366;\n"
        "export const TEMPERATURE_VALUE_SCALE = 0.1;\n"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path)
    parser.add_argument("--output", type=Path, default=Path("temperature-data.js"))
    args = parser.parse_args()
    source_dir = args.source_dir or Path(tempfile.mkdtemp(prefix="winter-road-temperature-"))
    daily = ensure_source(source_dir, "normal_amedas_daily.zip", DAILY_URL)
    station_index = ensure_source(source_dir, "amedas_station_index.zip", STATION_URL)
    stations = load_stations(station_index)
    load_daily_minima(daily, stations)
    complete = [station for station in stations.values() if "values" in station]
    selected = select_stations(complete, STATION_COUNT)
    module = build_module(selected, sha256(daily), sha256(station_index))
    args.output.write_text(module, encoding="utf-8")
    print(f"wrote {args.output} with {len(selected)} stations and 366 days")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
