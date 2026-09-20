#!/usr/bin/env python3
"""Regression checks for fail-closed release scanning."""

from __future__ import annotations

import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import privacy_gate as gate


SOURCE_ROOT = gate.ROOT


class WorktreeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.allow = json.loads(gate.ALLOWLIST_PATH.read_text(encoding="utf-8"))

    def test_current_worktree_has_no_findings(self):
        self.assertEqual(gate.validate_worktree(self.allow), [])

    def test_unlisted_file_is_rejected_without_echoing_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            name = "private-sample.txt"
            (root / name).write_text("harmless fixture", encoding="utf-8")
            with patch.object(gate, "ROOT", root):
                findings = gate.validate_worktree(self.allow)
            label = "file@" + gate.digest_bytes(name.encode())[:12]
            self.assertTrue(any("not allowlisted" in item and label in item for item in findings))
            self.assertNotIn(name, "\n".join(findings))

    def test_vendor_hash_mismatch_is_rejected(self):
        vendor = self.allow["allowed_vendored_files"][0]
        changed = {**vendor, "sha256": "0" * 64}
        allow = {**self.allow, "allowed_vendored_files": [changed, *self.allow["allowed_vendored_files"][1:]]}
        findings = gate.validate_worktree(allow)
        self.assertTrue(any("vendored file" in item for item in findings))


class ScannerTests(unittest.TestCase):
    def test_secret_and_local_path_are_rejected(self):
        secret = "gh" + "p_" + "A" * 40
        findings = gate.scan_text("fixture", secret + " /Us" + "ers/sample/file", set(), set())
        self.assertTrue(any("secret pattern" in item for item in findings))
        self.assertTrue(any("local path" in item for item in findings))

    def test_unapproved_browser_storage_is_rejected(self):
        findings = gate.scan_text("fixture.js", "window.local" + "Storage.clear()", set(), set())
        self.assertTrue(any("dangerous browser API" in item for item in findings))


class GitHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=".winter-road-privacy-", dir=SOURCE_ROOT.parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.addCleanup(setattr, gate, "ROOT", SOURCE_ROOT)
        gate.ROOT = self.root
        self.git("init", "--quiet", "--initial-branch=main")
        self.git("config", "user.name", "github-actions[bot]")
        self.git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com")
        (self.root / "safe.js").write_text("export const safe = true;\n", encoding="utf-8")
        self.git("add", "safe.js")
        self.git("commit", "--quiet", "-m", "Safe fixture")
        self.allow = {
            "allowed_git_identities": [{"name": "github-actions[bot]", "email": "41898282+github-actions[bot]@users.noreply.github.com"}],
            "allowed_external_hosts": [],
            "allowed_remote_urls": [],
            "allowed_binary_assets": [],
            "allowed_historical_binary_assets": [],
            "allowed_vendored_files": [],
            "allowed_files": ["safe.js"],
            "large_text_files": {},
            "max_file_bytes": 1000,
        }

    def git(self, *arguments):
        return subprocess.run(["git", "-C", str(self.root), *arguments], check=True, capture_output=True)

    def test_safe_history_passes(self):
        self.assertEqual(gate.validate_git(self.allow), [])

    def test_unreachable_bad_identity_is_rejected(self):
        tree = self.git("write-tree").stdout.decode().strip()
        identity = "Unapproved <41898282+github-actions[bot]@users.noreply.github.com>"
        payload = f"tree {tree}\nauthor {identity} 1700000000 +0000\ncommitter {identity} 1700000000 +0000\n\nDetached fixture\n"
        subprocess.run(["git", "-C", str(self.root), "hash-object", "-t", "commit", "-w", "--stdin"], input=payload.encode(), check=True, capture_output=True)
        self.assertTrue(any("identity" in item for item in gate.validate_git(self.allow)))

    def test_git_failure_cannot_pass(self):
        with patch.object(gate, "run_git", side_effect=subprocess.CalledProcessError(1, ["git"])):
            self.assertEqual(gate.validate_git(self.allow), ["Git inspection could not be completed; release blocked"])


class PageSecurityTests(unittest.TestCase):
    def test_csp_and_privacy_disclosure(self):
        html = (SOURCE_ROOT / "index.html").read_text(encoding="utf-8")
        for directive in ("default-src 'none'", "script-src 'self'", "style-src 'self'", "worker-src 'self'", "form-action 'none'"):
            self.assertIn(directive, html)
        for phrase in ("現在地を取得せず", "アクセス解析を使用しません", "IPアドレス", "国土地理院"):
            self.assertIn(phrase, html)
        self.assertNotIn("<script>", html)


if __name__ == "__main__":
    unittest.main()
