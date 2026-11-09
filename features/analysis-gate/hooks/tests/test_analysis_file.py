"""Tests for the shared analysis-file check. The clock is injected, so no test sleeps or reads the real time."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "analysis_file.py"
SPEC = importlib.util.spec_from_file_location("analysis_file", SCRIPT)
ANALYSIS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ANALYSIS)
NOW = 1_800_000_000.0
MINUTE = 60
FULL = "## Unknowns  \n- the cache policy\n\n## Class \nno defect: analysis file check\n"


class AnalysisFileTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)

    def write(self, content, age=0):
        path = self.root / ANALYSIS.ANALYSIS_RELATIVE
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        os.utime(path, (NOW - age, NOW - age))
        return path

    def test_missing_file(self):
        ok, reason = ANALYSIS.check(self.root, NOW)
        self.assertFalse(ok)
        self.assertIn(str(self.root / ANALYSIS.ANALYSIS_RELATIVE), reason)
        self.assertIn("missing", reason)
        self.assertIn("`## Unknowns`", reason)
        self.assertIn("`## Class`", reason)

    def test_stale_file_31_min(self):
        self.write(FULL.encode(), age=31 * MINUTE)
        ok, reason = ANALYSIS.check(self.root, NOW)
        self.assertFalse(ok)
        self.assertIn("stale, last written 31 min ago", reason)

    def test_fresh_full_file_ok(self):
        self.write(FULL.encode(), age=MINUTE)
        ok, reason = ANALYSIS.check(self.root, NOW)
        self.assertTrue(ok, reason)

    def test_future_mtime_beyond_limit_is_stale(self):
        self.write(FULL.encode(), age=-31 * MINUTE)
        ok, reason = ANALYSIS.check(self.root, NOW)
        self.assertFalse(ok)
        self.assertIn("in the future", reason)

    def test_missing_unknowns(self):
        self.write(b"## Class\nno defect: y\n")
        ok, reason = ANALYSIS.check(self.root, NOW)
        self.assertFalse(ok)
        self.assertIn("section `## Unknowns` missing", reason)

    def test_empty_class_heading_followed_by_heading(self):
        self.write(b"## Unknowns\n- x\n## Class\n## Other\n- z\n")
        ok, reason = ANALYSIS.check(self.root, NOW)
        self.assertFalse(ok)
        self.assertIn("section `## Class` empty", reason)

    def test_whitespace_only_class_body_is_empty(self):
        self.write(b"## Unknowns\n- x\n\n## Class\n   \n\t\n## Other\n- z\n")
        ok, reason = ANALYSIS.check(self.root, NOW)
        self.assertFalse(ok)
        self.assertIn("section `## Class` empty", reason)

    def test_crlf_file_ok(self):
        self.write(b"## Unknowns\r\n- x\r\n\r\n## Class\r\nno defect: y\r\n")
        ok, reason = ANALYSIS.check(self.root, NOW)
        self.assertTrue(ok, reason)

    def test_bom_and_invalid_utf8_bytes_do_not_break_headings(self):
        self.write(b"\xef\xbb\xbf## Unknowns\n- bad byte \xff here\n\n## Class\nno defect: y\n")
        ok, reason = ANALYSIS.check(self.root, NOW)
        self.assertTrue(ok, reason)

    def test_lookalike_headings_do_not_count_as_class(self):
        self.write(b"## Unknowns\n- x\n\n## Classes\n- y\n\n### Class\n- z\n")
        ok, reason = ANALYSIS.check(self.root, NOW)
        self.assertFalse(ok)
        self.assertIn("section `## Class` missing", reason)

    def test_project_root_env_wins(self):
        with mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": r"C:\work\project"}):
            self.assertEqual(ANALYSIS.project_root({"cwd": r"D:\other"}), Path(r"C:\work\project"))

    def test_project_root_empty_env_falls_back_to_payload_cwd(self):
        with mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": ""}):
            self.assertEqual(ANALYSIS.project_root({"cwd": str(self.root)}), self.root)

    def test_project_root_payload_cwd_when_env_unset(self):
        with mock.patch.dict(os.environ):
            os.environ.pop("CLAUDE_PROJECT_DIR", None)
            self.assertEqual(ANALYSIS.project_root({"cwd": str(self.root)}), self.root)

    def test_project_root_process_cwd_when_no_env_and_no_payload_cwd(self):
        with mock.patch.dict(os.environ), mock.patch.object(Path, "cwd", return_value=self.root):
            os.environ.pop("CLAUDE_PROJECT_DIR", None)
            self.assertEqual(ANALYSIS.project_root({}), self.root)


if __name__ == "__main__":
    unittest.main()
