"""Guard the per-category project denylist shared by the codex and volunteers launchers (project-denylist.py).

Run from the clone root: python -I -m unittest discover -s base/tools/tests -v
Every test injects the home directory; nothing reads the real ~ or its denylist file.
"""
import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

MODULE = Path(__file__).resolve().parents[1] / "project-denylist.py"
SPEC = importlib.util.spec_from_file_location("project_denylist", MODULE)
pd = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pd)

HINT = "do not use the feature"
CLI_TIMEOUT_SECONDS = 60
CATEGORIES = ("codex", "volunteers")


class Home:
    """A throwaway home directory with an optional denylist config and a few project directories."""

    def __init__(self, test):
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name).resolve()

    def config(self, data):
        path = self.root / ".agent-rig" / "project-denylist.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")

    def project(self, *parts):
        path = self.root.joinpath("projects", *parts)
        path.mkdir(parents=True, exist_ok=True)
        return path


class CheckTest(unittest.TestCase):
    def test_no_config_file_allows_everything(self):
        home = Home(self)
        self.assertEqual(pd.check("codex", str(home.project("bloxels")), home.root), (True, ""))

    def test_missing_category_key_denies_nothing_for_it(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        home.config({"volunteers": [str(bloxels)]})
        self.assertEqual(pd.check("codex", str(bloxels), home.root), (True, ""))
        self.assertFalse(pd.check("volunteers", str(bloxels), home.root)[0])

    def test_empty_list_denies_nothing(self):
        home = Home(self)
        home.config({"codex": []})
        self.assertEqual(pd.check("codex", str(home.project("bloxels")), home.root), (True, ""))

    def test_the_listed_directory_is_refused_naming_category_directory_and_file(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        home.config({"codex": [str(bloxels)], "volunteers": [str(bloxels)]})
        for category in CATEGORIES:
            allowed, reason = pd.check(category, str(bloxels), home.root)
            self.assertFalse(allowed)
            self.assertEqual(reason, f"REFUSED: {category} is not allowed in project {bloxels} "
                                     "(set in ~/.agent-rig/project-denylist.json)")

    def test_a_subdirectory_of_the_listed_directory_is_refused(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        sub = home.project("bloxels", "src", "deep")
        home.config({"codex": [str(bloxels)]})
        allowed, reason = pd.check("codex", str(sub), home.root)
        self.assertFalse(allowed)
        self.assertIn(str(bloxels), reason)

    def test_a_sibling_with_a_shared_name_prefix_is_allowed(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        backup = home.project("bloxels-backup-2026-11-06")
        parent = home.project()
        home.config({"codex": [str(bloxels)]})
        self.assertEqual(pd.check("codex", str(backup), home.root), (True, ""))
        # a parent of the listed directory is not inside it either
        self.assertEqual(pd.check("codex", str(parent), home.root), (True, ""))

    def test_separators_are_equivalent(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        sub = home.project("bloxels", "src")
        home.config({"codex": [bloxels.as_posix()]})
        self.assertFalse(pd.check("codex", str(sub).replace("/", os.sep), home.root)[0])
        self.assertFalse(pd.check("codex", sub.as_posix(), home.root)[0])
        home.config({"codex": [str(bloxels).replace("/", os.sep)]})
        self.assertFalse(pd.check("codex", sub.as_posix(), home.root)[0])

    def test_a_trailing_separator_does_not_matter(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        home.config({"codex": [bloxels.as_posix() + "/"]})
        self.assertFalse(pd.check("codex", str(bloxels), home.root)[0])
        self.assertFalse(pd.check("codex", bloxels.as_posix() + "/", home.root)[0])

    @unittest.skipUnless(os.name == "nt", "path case is significant on this OS")
    def test_case_is_ignored_where_the_os_ignores_it(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        home.config({"codex": [str(bloxels).upper()]})
        self.assertFalse(pd.check("codex", str(bloxels).lower(), home.root)[0])
        self.assertFalse(pd.check("codex", str(home.project("bloxels", "Src")).swapcase(), home.root)[0])

    @unittest.skipIf(os.name == "nt", "path case is ignored on this OS")
    def test_case_is_significant_where_the_os_distinguishes_it(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        home.config({"codex": [str(bloxels).upper()]})
        self.assertTrue(pd.check("codex", str(bloxels), home.root)[0])

    def link(self, target, link):
        """A directory link at `link` to `target`: a symlink, or a junction on Windows when symlinks are refused."""
        try:
            os.symlink(target, link, target_is_directory=True)
            return
        except OSError:
            if os.name != "nt":
                raise unittest.SkipTest("the OS refuses to create a symlink here")
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True,
                                check=False, timeout=CLI_TIMEOUT_SECONDS)
        if result.returncode != 0:
            raise unittest.SkipTest("the OS refuses to create a symlink or a junction here")

    def test_a_link_into_the_listed_directory_is_refused(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        link = home.project() / "innocent"
        self.link(bloxels, link)
        home.config({"codex": [str(bloxels)]})
        self.assertFalse(pd.check("codex", str(link), home.root)[0])

    def test_a_listed_link_denies_its_target(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        link = home.project() / "innocent"
        self.link(bloxels, link)
        home.config({"codex": [str(link)]})
        self.assertFalse(pd.check("codex", str(bloxels), home.root)[0])

    def test_a_directory_that_does_not_exist_is_still_matched_by_its_path(self):
        home = Home(self)
        bloxels = home.root / "projects" / "bloxels"
        home.config({"codex": [str(bloxels)]})
        self.assertFalse(pd.check("codex", str(bloxels / "gone"), home.root)[0])
        self.assertTrue(pd.check("codex", str(home.root / "projects" / "other"), home.root)[0])

    def test_any_listed_directory_matches(self):
        home = Home(self)
        first, second = home.project("first"), home.project("second")
        home.config({"codex": [str(first), str(second)]})
        allowed, reason = pd.check("codex", str(home.project("second", "x")), home.root)
        self.assertFalse(allowed)
        self.assertIn(str(second), reason)

    def test_malformed_config_refuses_every_category_naming_the_file(self):
        bad_configs = ["{oops", "[\"C:/x\"]", json.dumps({"codex": "C:/x"}), json.dumps({"codex": [1]}),
                       json.dumps({"volunteers": [""]}), json.dumps({"volunteers": [None]}),
                       json.dumps({"volunteers": {"a": "b"}})]
        for bad in bad_configs:
            home = Home(self)
            home.config(bad)
            for category in CATEGORIES:
                allowed, reason = pd.check(category, str(home.project("anything")), home.root)
                self.assertFalse(allowed, bad)
                self.assertIn("project-denylist.json", reason)
                self.assertIn("malformed", reason)
                self.assertTrue(reason.startswith("REFUSED"), reason)


class EntryPointsTest(unittest.TestCase):
    def test_refuse_if_blocked_exits_with_the_reason_only_when_denied(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        home.config({"codex": [str(bloxels)]})
        pd.refuse_if_blocked("codex", str(home.project("other")), home.root)
        with self.assertRaises(SystemExit) as raised:
            pd.refuse_if_blocked("codex", str(bloxels), home.root)
        self.assertIn(str(bloxels), str(raised.exception))

    def test_refuse_if_blocked_without_a_directory_uses_the_working_directory(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        home.config({"codex": [str(bloxels)]})
        with mock.patch.object(os, "getcwd", return_value=str(bloxels)):
            with self.assertRaises(SystemExit):
                pd.refuse_if_blocked("codex", home=home.root)
        with mock.patch.object(os, "getcwd", return_value=str(home.project("other"))):
            pd.refuse_if_blocked("codex", home=home.root)

    def test_session_hint_is_silent_when_allowed_and_json_when_denied(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        home.config({"codex": [str(bloxels)]})
        out = io.StringIO()
        pd.session_hint("codex", HINT, str(home.project("other")), home.root, out)
        self.assertEqual(out.getvalue(), "")
        pd.session_hint("codex", HINT, str(bloxels), home.root, out)
        payload = json.loads(out.getvalue())["hookSpecificOutput"]
        self.assertEqual(payload["hookEventName"], "SessionStart")
        self.assertIn(HINT, payload["additionalContext"])
        self.assertIn(str(bloxels), payload["additionalContext"])

    def test_the_hook_input_cwd_wins_over_the_process_working_directory(self):
        home = Home(self)
        process_dir = str(home.project("process"))
        with mock.patch.object(os, "getcwd", return_value=process_dir):
            stream = io.StringIO(json.dumps({"cwd": "C:/from/the/hook", "session_id": "x"}))
            stream.isatty = lambda: False
            self.assertEqual(pd.hook_project_dir(stream), "C:/from/the/hook")

    def test_the_working_directory_is_used_without_a_usable_hook_cwd(self):
        home = Home(self)
        process_dir = str(home.project("process"))
        for text in ("", "not json", "[]", json.dumps({}), json.dumps({"cwd": ""}), json.dumps({"cwd": 5})):
            stream = io.StringIO(text)
            stream.isatty = lambda: False
            with mock.patch.object(os, "getcwd", return_value=process_dir):
                self.assertEqual(pd.hook_project_dir(stream), process_dir, text)
        tty = io.StringIO("{\"cwd\": \"C:/never/read\"}")
        tty.isatty = lambda: True
        with mock.patch.object(os, "getcwd", return_value=process_dir):
            self.assertEqual(pd.hook_project_dir(tty), process_dir)

    def test_importing_the_module_does_not_run_the_cli(self):
        spec = importlib.util.spec_from_file_location("project_denylist_import", MODULE)
        module = importlib.util.module_from_spec(spec)
        out = io.StringIO()
        argv = ["project-denylist.py", "check", "codex", "--project-dir", "x"]
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(out):
            spec.loader.exec_module(module)
        self.assertEqual(out.getvalue(), "")


class CliRunner(unittest.TestCase):
    """Shared subprocess runner with a fake HOME (and USERPROFILE on Windows); holds no tests, so subclasses do not re-run each other's."""

    def run_cli(self, home, argv):
        env = {key: value for key, value in os.environ.items() if key not in ("HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH")}
        env["HOME"] = env["USERPROFILE"] = str(home.root)
        return subprocess.run([sys.executable, "-I", str(MODULE), *argv], env=env, capture_output=True,
                              encoding="utf-8", timeout=CLI_TIMEOUT_SECONDS, check=False)


class CliTest(CliRunner):
    """`check <category> --project-dir <dir>` run as a subprocess."""

    def query(self, home, category, project_dir):
        proc = self.run_cli(home, ["check", category, "--project-dir", str(project_dir)])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(proc.stdout.splitlines()), 1, proc.stdout)
        return json.loads(proc.stdout)

    def test_an_unlisted_project_prints_allowed_true_with_empty_reason(self):
        home = Home(self)
        home.config({"codex": [str(home.project("bloxels"))]})
        self.assertEqual(self.query(home, "codex", home.project("other")), {"allowed": True, "reason": ""})

    def test_a_denied_project_prints_the_refusal_and_still_exits_zero(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        home.config({"codex": [str(bloxels)]})
        result = self.query(home, "codex", home.project("bloxels", "sub"))
        self.assertFalse(result["allowed"])
        self.assertTrue(result["reason"].startswith("REFUSED"))
        self.assertIn(str(bloxels), result["reason"])
        self.assertIn("project-denylist.json", result["reason"])

    def test_the_other_category_is_not_denied(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        home.config({"codex": [str(bloxels)]})
        self.assertTrue(self.query(home, "volunteers", bloxels)["allowed"])

    def test_no_file_denies_nothing(self):
        home = Home(self)
        self.assertEqual(self.query(home, "volunteers", home.project("bloxels")), {"allowed": True, "reason": ""})

    def test_malformed_config_prints_a_refusal_naming_the_file(self):
        home = Home(self)
        home.config("{oops")
        result = self.query(home, "volunteers", home.project("any"))
        self.assertFalse(result["allowed"])
        self.assertIn("malformed", result["reason"])
        self.assertIn("project-denylist.json", result["reason"])

    def test_unknown_category_is_an_argparse_error(self):
        home = Home(self)
        proc = self.run_cli(home, ["check", "telegram", "--project-dir", "x"])
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")
        self.assertIn("invalid choice", proc.stderr)

    def test_missing_or_empty_project_dir_category_or_command_is_a_usage_error(self):
        home = Home(self)
        for argv in (["check", "codex"], ["check", "codex", "--project-dir", ""], ["check", "--project-dir", "x"],
                     ["batch"], ["batch", "--category", "codex"], []):
            proc = self.run_cli(home, argv)
            self.assertNotEqual(proc.returncode, 0, argv)
            self.assertEqual(proc.stdout, "", argv)


class BatchCliTest(CliRunner):
    """`batch --project-dir <dir> --category <name>...` prints {"categories"} as one JSON line."""

    def test_batch_answers_every_requested_category(self):
        home = Home(self)
        bloxels = home.project("bloxels")
        home.config({"codex": [str(bloxels)]})
        proc = self.run_cli(home, ["batch", "--project-dir", str(bloxels), "--category", "codex", "--category", "volunteers"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(proc.stdout.splitlines()), 1, proc.stdout)
        categories = json.loads(proc.stdout)["categories"]
        self.assertEqual(list(categories), ["codex", "volunteers"])
        self.assertFalse(categories["codex"]["allowed"])
        self.assertIn(str(bloxels), categories["codex"]["reason"])
        self.assertEqual(categories["volunteers"], {"allowed": True, "reason": ""})

    def test_batch_with_a_malformed_file_refuses_every_category(self):
        home = Home(self)
        home.config("{oops")
        proc = self.run_cli(home, ["batch", "--project-dir", str(home.project("x")), "--category", "codex", "--category", "volunteers"])
        categories = json.loads(proc.stdout)["categories"]
        self.assertFalse(categories["codex"]["allowed"])
        self.assertFalse(categories["volunteers"]["allowed"])


class BatchIsolationTest(unittest.TestCase):
    """One category that raises is reported as {"error": text}; the others keep their answers."""

    def test_a_raising_category_does_not_fail_the_others(self):
        def check(category, project_dir, home=None):
            if category == "codex":
                raise OSError("unreadable")
            return True, ""
        out = io.StringIO()
        with mock.patch.object(pd, "check", check), contextlib.redirect_stdout(out):
            self.assertEqual(pd.main(["batch", "--project-dir", "x", "--category", "codex", "--category", "volunteers"]), 0)
        categories = json.loads(out.getvalue())["categories"]
        self.assertEqual(categories["volunteers"], {"allowed": True, "reason": ""})
        self.assertIn("unreadable", categories["codex"]["error"])


if __name__ == "__main__":
    unittest.main()
