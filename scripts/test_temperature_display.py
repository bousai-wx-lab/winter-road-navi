#!/usr/bin/env python3
"""Small release fixtures verify acceptance and fail-closed data boundaries."""

from __future__ import annotations

import hashlib
import gzip
import json
from pathlib import Path
import tempfile
import unittest

import verify_temperature_display as check
import privacy_gate as gate


class TemperatureDisplayTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="temperature-fixture-", dir=check.ROOT.parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.base = self.root / "data/temperature"
        self.base.mkdir(parents=True)
        self.days = ["02-28", "02-29", "03-01"]
        self.manifest = {"schema_version": 1, "days": self.days, "cell_count": 8,
                         "bin_min": -40, "bin_step": 1, "bin_count": 81, "missing_bin": 0,
                         "source_id": "climate-normal-example", "unit": "C",
                         "road_classes": json.loads(json.dumps(check.ROAD_CLASSES)),
                         "grid": self.write("grid.json", {"cell_count": 8, "runs": [4000, 10000, 4, 4001, 10000, 4]}),
                         "files": []}
        for day in self.days:
            entry = self.write(day + ".json.gz", {"day": day, "cell_count": 8, "runs": [0, 2, 1, 2, 41, 2, 81, 2],
                                                  "road_runs": [0, 2, 4, 2, 3, 2, 1, 2]})
            self.manifest["files"].append({"day": day, **entry})

    def write(self, name, value):
        raw = (json.dumps(value, separators=(",", ":")) + "\n").encode()
        payload = gzip.compress(raw, mtime=0) if name.endswith(".gz") else raw
        (self.base / name).write_bytes(payload)
        entry = {"url": name, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
        if name.endswith(".gz"):
            entry["uncompressed_bytes"] = len(raw)
        return entry

    def verify(self):
        self.write("manifest.json", self.manifest)
        return check.verify(self.base / "manifest.json", root=self.root,
                            expected_count=8, expected_missing=2, expected_days=self.days)

    def replace_day(self, value):
        day = self.days[0]
        value.setdefault("road_runs", [0, 2, 4, 2, 3, 2, 1, 2])
        self.manifest["files"][0] = {"day": day, **self.write(day + ".json.gz", value)}

    def test_valid_calendar_and_numeric_edges(self):
        self.assertEqual(self.verify(), {"days": 3, "grid_cells": 8, "missing_cells_per_day": 2, "files": 5})
        self.assertEqual(len(check.DAYS), 366)
        self.assertEqual(check.DAYS[59:61], ["02-29", "03-01"])

    def test_duplicate_day_rejected(self):
        self.manifest["files"][1]["day"] = "02-28"
        with self.assertRaisesRegex(ValueError, "duplicate or unordered"):
            self.verify()

    def test_invalid_bins_rejected(self):
        for invalid in (-1, 82, True, 1.5):
            with self.subTest(invalid=invalid):
                self.replace_day({"day": "02-28", "cell_count": 8, "runs": [0, 2, invalid, 6]})
                with self.assertRaisesRegex(ValueError, "temperature bin"):
                    self.verify()

    def test_short_and_long_runs_rejected(self):
        for length in (5, 7):
            with self.subTest(length=length):
                self.replace_day({"day": "02-28", "cell_count": 8, "runs": [0, 2, 41, length]})
                with self.assertRaisesRegex(ValueError, "cell count"):
                    self.verify()

    def test_missing_count_rejected(self):
        self.replace_day({"day": "02-28", "cell_count": 8, "runs": [0, 1, 41, 7]})
        with self.assertRaisesRegex(ValueError, "missing count"):
            self.verify()

    def test_grid_overlap_and_order_rejected(self):
        for runs in ([4000, 10000, 4, 4000, 10003, 4], [4001, 10000, 4, 4000, 10000, 4]):
            with self.subTest(runs=runs):
                self.manifest["grid"] = self.write("grid.json", {"cell_count": 8, "runs": runs})
                with self.assertRaisesRegex(ValueError, "duplicate or unordered"):
                    self.verify()

    def test_digest_mismatch_rejected(self):
        self.manifest["files"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            self.verify()

    def test_byte_mismatch_rejected(self):
        self.manifest["grid"]["bytes"] += 1
        with self.assertRaisesRegex(ValueError, "byte count mismatch"):
            self.verify()

    def test_unlisted_file_rejected(self):
        self.write("unlisted.json", {})
        with self.assertRaisesRegex(ValueError, "inventory mismatch"):
            self.verify()

    def test_invalid_metadata_rejected(self):
        self.manifest["source_id"] = []
        with self.assertRaisesRegex(ValueError, "source identity"):
            self.verify()

    def test_incomplete_calendar_rejected(self):
        self.manifest["days"] = ["02-28", "03-01"]
        with self.assertRaisesRegex(ValueError, "calendar incomplete"):
            self.verify()

    def test_road_definitions_are_required_and_exact(self):
        original = self.manifest["road_classes"]
        for value in (None, original[:-1], [{**original[0], "id": False}, *original[1:]],
                      [original[0], {**original[1], "lower_exclusive_c": 6}, *original[2:]]):
            with self.subTest(value=value):
                self.manifest["road_classes"] = value
                with self.assertRaisesRegex(ValueError, "road class definitions"):
                    self.verify()

    def test_road_boundary_bins_and_split_runs(self):
        # Values -0.1, 0, 0.1, 1.9, 2, 2.1, 4.9, 5, 5.1, missing.
        value = {"day": "01-15", "cell_count": 10,
                 "runs": [40, 1, 41, 2, 42, 1, 43, 2, 45, 1, 46, 2, 0, 1],
                 "road_runs": [4, 2, 3, 3, 2, 3, 1, 1, 0, 1]}
        check.validate_day(value, "01-15", 10, 1)
        for bin_value, road_class in ((40, 3), (42, 4), (44, 3), (45, 1), (47, 2), (81, 4)):
            with self.subTest(bin_value=bin_value, road_class=road_class):
                bad = {"day": "01-15", "cell_count": 1, "runs": [bin_value, 1], "road_runs": [road_class, 1]}
                with self.assertRaisesRegex(ValueError, "road class/temperature bin"):
                    check.validate_day(bad, "01-15", 1, 0)

    def test_road_runs_required(self):
        value = {"day": "01-15", "cell_count": 1, "runs": [41, 1]}
        with self.assertRaisesRegex(ValueError, "unexpected daily fields"):
            check.validate_day(value, "01-15", 1, 0)

    def test_invalid_road_class_and_run_lengths(self):
        for invalid in (-1, 5, True, 1.5):
            with self.subTest(invalid=invalid):
                self.replace_day({"day": "02-28", "cell_count": 8, "runs": [0, 2, 41, 6],
                                  "road_runs": [0, 2, invalid, 6]})
                with self.assertRaisesRegex(ValueError, "road class"):
                    self.verify()
        for runs, message in (([], "invalid road runs"), ([0, 2, 3], "invalid road runs"),
                              ([0, 2, 3, 0], "road run length"), ([0, 2, 3, 5], "cell count"),
                              ([0, 2, 3, 7], "cell count"), ([0, 1, 3, 7], "road missing count")):
            with self.subTest(runs=runs):
                self.replace_day({"day": "02-28", "cell_count": 8, "runs": [0, 2, 41, 6], "road_runs": runs})
                with self.assertRaisesRegex(ValueError, message):
                    self.verify()

    def test_road_missing_positions_must_match_mesh_missing(self):
        self.replace_day({"day": "02-28", "cell_count": 8, "runs": [0, 2, 41, 6],
                          "road_runs": [3, 2, 0, 2, 3, 4]})
        with self.assertRaisesRegex(ValueError, "missing position mismatch"):
            self.verify()

    def test_traversal_rejected(self):
        self.manifest["files"][0]["url"] = "../outside.json"
        with self.assertRaisesRegex(ValueError, "unsafe asset URL"):
            self.verify()

    def test_expanded_byte_count_mismatch_rejected(self):
        self.manifest["files"][0]["uncompressed_bytes"] += 1
        with self.assertRaisesRegex(ValueError, "expanded byte count mismatch"):
            self.verify()

    def test_gzip_envelope_rejections(self):
        raw = b'{"day":"01-15","cell_count":387717,"runs":[0,4220,41,383497]}'
        packed = gzip.compress(raw, mtime=0)
        cases = {
            "trailing": packed + b"extra",
            "second_member": packed + packed,
            "truncated": packed[:-4],
            "timestamp": gzip.compress(raw, mtime=1),
            "oversized": gzip.compress(b" " * (check.MAX_DAILY_JSON_BYTES + 1), mtime=0),
        }
        for name, payload in cases.items():
            with self.subTest(name=name), self.assertRaises(ValueError):
                check.decode_temperature_gzip(payload, len(raw))

    def test_gzip_duplicate_json_field_rejected(self):
        raw = b'{"day":"01-15","day":"01-16","cell_count":387717,"runs":[0,4220,41,383497]}'
        with self.assertRaisesRegex(ValueError, "duplicate JSON field"):
            check.decode_temperature_gzip(gzip.compress(raw, mtime=0), len(raw))

    def test_existing_terrain_gzip_contract_preserved(self):
        value = {"v": 1, "z": 5, "x": 1, "y": 2, "n": 128,
                 "e": [0] * 16384, "a": [0] * 16384}
        raw = json.dumps(value, separators=(",", ":")).encode()
        payload = gzip.compress(raw, mtime=0)
        record = {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
                  "raw_bytes": len(raw), "mime_type": "application/gzip"}
        self.assertEqual(gate.validate_binary_asset("data/area-v1/5/1/2.json.gz", payload, record), [])

    def test_mesh_only_gzip_requires_explicit_historical_context(self):
        raw = b'{"day":"01-15","cell_count":387717,"runs":[0,4220,41,383497]}'
        payload = gzip.compress(raw, mtime=0)
        record = {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
                  "uncompressed_bytes": len(raw), "mime_type": "application/gzip"}
        path = "data/temperature/01-15.json.gz"
        self.assertTrue(gate.validate_binary_asset(path, payload, record))
        self.assertEqual(gate.validate_binary_asset(path, payload, record, historical=True), [])
        # The historical escape only permits the exact previous numeric schema.
        bad_raw = raw[:-1] + b',"source_path":"unapproved"}'
        bad = gzip.compress(bad_raw, mtime=0)
        bad_record = {**record, "bytes": len(bad), "sha256": hashlib.sha256(bad).hexdigest(),
                      "uncompressed_bytes": len(bad_raw)}
        self.assertTrue(gate.validate_binary_asset(path, bad, bad_record, historical=True))

    def test_gzip_privacy_gate_acceptance_and_rejections(self):
        path = "data/temperature/01-15.json.gz"
        good = {"day": "01-15", "cell_count": 387717, "runs": [0, 4220, 41, 383497],
                "road_runs": [0, 4220, 3, 383497]}
        cases = {
            "valid": good,
            "wrong_day": {**good, "day": "01-16"},
            "wrong_count": {**good, "cell_count": 8},
            "extra_field": {**good, "extra": "text"},
            "invalid_bin": {**good, "runs": [0, 4220, 82, 383497]},
            "noninteger": {**good, "runs": [0, 4220, True, 383497]},
            "short": {**good, "runs": [0, 4220, 41, 383496]},
            "missing": {**good, "runs": [0, 4219, 41, 383498]},
            "invalid_road_class": {**good, "road_runs": [0, 4220, 5, 383497]},
            "wrong_road_bin": {**good, "road_runs": [0, 4220, 1, 383497]},
            "wrong_road_missing_position": {**good, "road_runs": [3, 4220, 0, 4220, 3, 379277]},
            "old_no_road_data": {key: value for key, value in good.items() if key != "road_runs"},
        }
        for name, value in cases.items():
            raw = json.dumps(value).encode()
            payload = gzip.compress(raw, mtime=0)
            record = {"bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest(),
                      "uncompressed_bytes": len(raw), "mime_type": "application/gzip"}
            with self.subTest(name=name):
                findings = gate.validate_binary_asset(path, payload, record)
                self.assertEqual(bool(findings), name != "valid")
        self.assertTrue(gate.validate_binary_asset("data/temperature/02-30.json.gz", payload, record))


if __name__ == "__main__":
    unittest.main()
