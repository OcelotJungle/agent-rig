"""Guard the cswap account allowlist shared by the codex and volunteers launchers (account-allowlist.py).

Run from the clone root: python -I -m unittest discover -s base/tools/tests -v
Every test injects the home directory and the environment; nothing reads the real ~ or cswap files.
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

MODULE = Path(__file__).resolve().parents[1] / "account-allowlist.py"
SPEC = importlib.util.spec_from_file_location("account_allowlist", MODULE)
al = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(al)

ACTIVE_ACCOUNT = 4
HINT = "do not use the feature"
CLI_TIMEOUT_SECONDS = 60
# Variables that pick the home directory or the Claude config dir; the CLI tests set the ones they need.
HOME_ENV = ("HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "CLAUDE_CONFIG_DIR")


class Home:
    """A throwaway home directory with optional cswap files and allowlist config."""

    def __init__(self, test):
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def sequence(self, text=None, active=ACTIVE_ACCOUNT):
        path = self.root / ".claude-swap-backup" / "sequence.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text if text is not None else json.dumps({"activeAccountNumber": active, "accounts": {"1": {}, "4": {}}}),
                        encoding="utf-8")

    def config(self, data):
        path = self.root / ".agent-rig" / "account-allowlist.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data if isinstance(data, str) else json.dumps(data), encoding="utf-8")

    def side_dir(self, name):
        return str(self.root / ".claude-swap-backup" / "sessions" / name)

    def side_env(self, name):
        return {"CLAUDE_CONFIG_DIR": self.side_dir(name)}

    def main_env(self):
        return {"CLAUDE_CONFIG_DIR": str(self.root / ".claude")}


class CurrentAccountTest(unittest.TestCase):
    def test_no_cswap_means_unknown_account(self):
        home = Home(self)
        self.assertEqual(al.current_account({}, home.root), (False, None))

    def test_main_login_without_config_dir_is_the_active_account(self):
        home = Home(self)
        home.sequence()
        self.assertEqual(al.current_account({}, home.root), (True, ACTIVE_ACCOUNT))

    def test_main_login_with_config_dir_resolving_to_dot_claude(self):
        home = Home(self)
        home.sequence()
        self.assertEqual(al.current_account(home.main_env(), home.root), (True, ACTIVE_ACCOUNT))

    def test_side_profile_takes_the_number_from_the_dir_prefix(self):
        home = Home(self)
        home.sequence()
        self.assertEqual(al.current_account(home.side_env("1-someone_example.com"), home.root), (True, 1))
        self.assertEqual(al.current_account(home.side_env("12-x"), home.root), (True, 12))

    def test_side_profile_without_a_number_is_undeterminable(self):
        home = Home(self)
        home.sequence()
        self.assertEqual(al.current_account(home.side_env("work-profile"), home.root), (True, None))
        self.assertEqual(al.current_account(home.side_env("1"), home.root), (True, None))

    def test_unreadable_sequence_leaves_the_main_account_undeterminable(self):
        home = Home(self)
        home.sequence("{not json")
        self.assertEqual(al.current_account({}, home.root), (True, None))
        home.sequence(json.dumps({"activeAccountNumber": "4"}))
        self.assertEqual(al.current_account({}, home.root), (True, None))

    def test_unreadable_sequence_does_not_hide_a_side_profile_number(self):
        home = Home(self)
        home.sequence("[]")
        self.assertEqual(al.current_account(home.side_env("2-x"), home.root), (True, 2))


class CheckTest(unittest.TestCase):
    def check(self, home, category="codex", env=None):
        return al.check(category, {} if env is None else env, home.root)

    def test_no_config_file_allows_everything(self):
        home = Home(self)
        home.sequence()
        self.assertEqual(self.check(home, env=home.side_env("2-x")), (True, ""))

    def test_missing_category_key_is_unrestricted(self):
        home = Home(self)
        home.sequence()
        home.config({"volunteers": [1]})
        self.assertEqual(self.check(home, "codex", home.side_env("2-x")), (True, ""))
        self.assertFalse(self.check(home, "volunteers", home.side_env("2-x"))[0])

    def test_listed_main_and_side_accounts_are_allowed(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": [1, 4]})
        self.assertTrue(self.check(home)[0])
        self.assertTrue(self.check(home, env=home.side_env("1-x"))[0])

    def test_unlisted_account_is_refused_with_category_number_and_file(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": [1, 4], "volunteers": [1, 4]})
        for category in ("codex", "volunteers"):
            allowed, reason = self.check(home, category, home.side_env("2-x"))
            self.assertFalse(allowed)
            self.assertIn(category, reason)
            self.assertIn("account 2", reason)
            self.assertIn("account-allowlist.json", reason)
            self.assertTrue(reason.startswith("REFUSED"))

    def test_unlisted_main_account_is_refused(self):
        home = Home(self)
        home.sequence(active=2)
        home.config({"codex": [1, 4]})
        self.assertFalse(self.check(home)[0])

    def test_no_cswap_means_no_restriction(self):
        home = Home(self)
        home.config({"codex": [1]})
        self.assertEqual(self.check(home), (True, ""))

    def test_undeterminable_account_fails_closed_when_the_category_is_listed(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": [1, 4]})
        allowed, reason = self.check(home, env=home.side_env("odd"))
        self.assertFalse(allowed)
        self.assertIn("cannot be determined", reason)
        self.assertIn("account-allowlist.json", reason)

    def test_undeterminable_account_is_fine_for_an_unlisted_category(self):
        home = Home(self)
        home.sequence()
        home.config({"volunteers": [1]})
        self.assertTrue(self.check(home, "codex", home.side_env("odd"))[0])

    def test_empty_list_blocks_every_account(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": []})
        self.assertFalse(self.check(home)[0])

    def test_malformed_config_refuses_every_category_naming_the_file(self):
        bad_configs = ["{oops", "[1, 4]", json.dumps({"codex": "1"}), json.dumps({"codex": [1, "4"]}),
                       json.dumps({"volunteers": [True]})]
        for bad in bad_configs:
            home = Home(self)
            home.config(bad)
            for category in ("codex", "volunteers"):
                allowed, reason = self.check(home, category)
                self.assertFalse(allowed, bad)
                self.assertIn("account-allowlist.json", reason)
                self.assertIn("malformed", reason)

    def test_malformed_config_refuses_even_without_cswap(self):
        home = Home(self)
        home.config("{oops")
        self.assertFalse(self.check(home)[0])


class EntryPointsTest(unittest.TestCase):
    def test_refuse_if_blocked_exits_with_the_reason_only_when_blocked(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": [1, 4]})
        al.refuse_if_blocked("codex", {}, home.root)
        with self.assertRaises(SystemExit) as raised:
            al.refuse_if_blocked("codex", home.side_env("2-x"), home.root)
        self.assertIn("account 2", str(raised.exception))

    def test_session_hint_is_silent_when_allowed_and_json_when_blocked(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": [1, 4]})
        out = io.StringIO()
        al.session_hint("codex", HINT, {}, home.root, out)
        self.assertEqual(out.getvalue(), "")
        al.session_hint("codex", HINT, home.side_env("2-x"), home.root, out)
        payload = json.loads(out.getvalue())["hookSpecificOutput"]
        self.assertEqual(payload["hookEventName"], "SessionStart")
        self.assertIn(HINT, payload["additionalContext"])
        self.assertIn("account 2", payload["additionalContext"])

    def test_importing_the_module_does_not_run_the_cli(self):
        spec = importlib.util.spec_from_file_location("account_allowlist_import", MODULE)
        module = importlib.util.module_from_spec(spec)
        out = io.StringIO()
        argv = ["account-allowlist.py", "check", "codex", "--config-dir", ""]
        with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(out):
            spec.loader.exec_module(module)
        self.assertEqual(out.getvalue(), "")


class CliRunner(unittest.TestCase):
    """Shared subprocess runner with a fake HOME (and USERPROFILE on Windows); holds no tests, so subclasses do not re-run each other's."""

    def run_cli(self, home, argv, own_config_dir=None):
        env = {key: value for key, value in os.environ.items() if key not in HOME_ENV}
        env["HOME"] = env["USERPROFILE"] = str(home.root)
        if own_config_dir is not None:
            env["CLAUDE_CONFIG_DIR"] = own_config_dir
        return subprocess.run([sys.executable, "-I", str(MODULE), *argv], env=env, capture_output=True,
                              encoding="utf-8", timeout=CLI_TIMEOUT_SECONDS, check=False)


class CliTest(CliRunner):
    """`check <category> --config-dir <dir>` run as a subprocess."""

    def query(self, home, category, config_dir=None, own_config_dir=None):
        argv = ["check", category]
        if config_dir is not None:
            argv += ["--config-dir", config_dir]
        proc = self.run_cli(home, argv, own_config_dir)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(proc.stdout.splitlines()), 1, proc.stdout)
        return json.loads(proc.stdout)

    def test_allowed_account_prints_allowed_true_with_empty_reason(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": [1, 4]})
        self.assertEqual(self.query(home, "codex", home.side_dir("1-x")), {"allowed": True, "reason": ""})

    def test_refused_side_profile_prints_the_refusal_and_still_exits_zero(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": [1, 4]})
        result = self.query(home, "codex", home.side_dir("2-x"))
        self.assertFalse(result["allowed"])
        self.assertTrue(result["reason"].startswith("REFUSED"))
        self.assertIn("account 2", result["reason"])
        self.assertIn("account-allowlist.json", result["reason"])

    def test_empty_config_dir_is_the_main_login_account(self):
        home = Home(self)
        home.sequence(active=2)
        home.config({"codex": [1, 4]})
        self.assertFalse(self.query(home, "codex", "")["allowed"])
        home.sequence(active=4)
        self.assertEqual(self.query(home, "codex", ""), {"allowed": True, "reason": ""})

    def test_omitted_config_dir_is_the_main_login_account(self):
        home = Home(self)
        home.sequence(active=2)
        home.config({"codex": [1, 4]})
        self.assertFalse(self.query(home, "codex")["allowed"])

    def test_own_claude_config_dir_is_ignored(self):
        home = Home(self)
        home.sequence()
        home.config({"codex": [1, 4]})
        # the process's own CLAUDE_CONFIG_DIR points at refused account 2; the query is about the main login (4)
        self.assertTrue(self.query(home, "codex", "", own_config_dir=home.side_dir("2-x"))["allowed"])
        self.assertTrue(self.query(home, "codex", None, own_config_dir=home.side_dir("2-x"))["allowed"])
        # the flag wins over the process's own variable: own says account 1 (allowed), the flag says account 2
        self.assertFalse(self.query(home, "codex", home.side_dir("2-x"),
                                    own_config_dir=home.side_dir("1-x"))["allowed"])

    def test_unrestricted_without_cswap_is_allowed_even_when_listed_empty(self):
        home = Home(self)
        home.config({"volunteers": []})
        self.assertEqual(self.query(home, "volunteers", ""), {"allowed": True, "reason": ""})

    def test_malformed_config_prints_a_refusal_naming_the_file(self):
        home = Home(self)
        home.config("{oops")
        result = self.query(home, "volunteers", "")
        self.assertFalse(result["allowed"])
        self.assertIn("malformed", result["reason"])
        self.assertIn("account-allowlist.json", result["reason"])

    def test_unknown_category_is_an_argparse_error(self):
        home = Home(self)
        proc = self.run_cli(home, ["check", "telegram", "--config-dir", ""])
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")
        self.assertIn("invalid choice", proc.stderr)

    def test_missing_category_or_command_is_a_usage_error(self):
        home = Home(self)
        for argv in (["check"], []):
            proc = self.run_cli(home, argv)
            self.assertNotEqual(proc.returncode, 0, argv)
            self.assertEqual(proc.stdout, "", argv)


class BatchCliTest(CliRunner):
    """`batch --config-dir <dir>...` prints {"accounts", "categories"} as one JSON line."""

    def test_batch_queries_directories_and_categories(self):
        home = Home(self)
        home.sequence(active=3)
        home.config({"codex": [3], "volunteers": []})
        side = home.side_dir("2-x")
        proc = self.run_cli(home, ["batch", "--config-dir", "", "--config-dir", side,
                                   "--config-dir", side, "--category", "codex", "--category", "volunteers"])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["accounts"], {"": {"present": True, "account": 3},
                                              side: {"present": True, "account": 2}})
        self.assertTrue(result["categories"]["codex"]["allowed"])
        self.assertFalse(result["categories"]["volunteers"]["allowed"])

    def test_batch_without_cswap_or_known_account(self):
        home = Home(self)
        side = home.side_dir("odd")
        proc = self.run_cli(home, ["batch", "--config-dir", side, "--config-dir", ""])
        accounts = json.loads(proc.stdout)["accounts"]
        self.assertEqual(accounts[side], {"present": False, "account": None})
        self.assertEqual(accounts[""], {"present": False, "account": None})
        home.sequence()
        proc = self.run_cli(home, ["batch", "--config-dir", side])
        self.assertEqual(json.loads(proc.stdout)["accounts"][side], {"present": True, "account": None})


class BatchIsolationTest(unittest.TestCase):
    """One directory or category that raises is reported as {"error": text}; the others keep their answers."""

    def run_batch(self, argv, **patches):
        out = io.StringIO()
        with contextlib.ExitStack() as stack:
            for name, value in patches.items():
                stack.enter_context(mock.patch.object(al, name, value))
            stack.enter_context(contextlib.redirect_stdout(out))
            self.assertEqual(al.main(argv), 0)
        return json.loads(out.getvalue())

    def test_a_raising_directory_does_not_fail_the_others(self):
        def account(env=None, home=None):
            directory = (env or {}).get("CLAUDE_CONFIG_DIR", "")
            if directory == "bad":
                raise ValueError("embedded null byte")
            return True, 7
        result = self.run_batch(["batch", "--config-dir", "good", "--config-dir", "bad", "--config-dir", "fine"],
                                current_account=account)
        self.assertEqual(result["accounts"]["good"], {"present": True, "account": 7})
        self.assertEqual(result["accounts"]["fine"], {"present": True, "account": 7})
        self.assertIn("embedded null byte", result["accounts"]["bad"]["error"])

    def test_a_raising_category_does_not_fail_the_others(self):
        def check(category, env=None, home=None):
            if category == "codex":
                raise OSError("unreadable")
            return True, ""
        result = self.run_batch(["batch", "--config-dir", "good", "--category", "codex", "--category", "volunteers"],
                                check=check)
        self.assertEqual(result["categories"]["volunteers"], {"allowed": True, "reason": ""})
        self.assertIn("unreadable", result["categories"]["codex"]["error"])


class OwnerCliTest(CliRunner):
    """`owner --account <N>` prints {"accountUuid", "organizationUuid"} of cswap account N, or {"error"}; exit 0 in both cases."""

    FAKE_ENTRY = {"uuid": "fake-account-uuid", "organizationUuid": "fake-org-uuid"}

    def owner(self, home, account):
        proc = self.run_cli(home, ["owner", "--account", account])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(proc.stdout.splitlines()), 1, proc.stdout)
        return json.loads(proc.stdout)

    def sequence_with(self, home, accounts):
        home.sequence(json.dumps({"activeAccountNumber": 1, "accounts": accounts}))

    def test_found_account_prints_both_uuids(self):
        home = Home(self)
        self.sequence_with(home, {"4": self.FAKE_ENTRY})
        self.assertEqual(self.owner(home, "4"),
                         {"accountUuid": "fake-account-uuid", "organizationUuid": "fake-org-uuid"})

    def test_leading_zeros_name_the_same_decimal_account(self):
        home = Home(self)
        self.sequence_with(home, {"4": self.FAKE_ENTRY})
        self.assertEqual(self.owner(home, "04")["accountUuid"], "fake-account-uuid")

    def test_unknown_account_is_an_error_line(self):
        home = Home(self)
        self.sequence_with(home, {"4": self.FAKE_ENTRY})
        result = self.owner(home, "9")
        self.assertEqual(list(result), ["error"])
        self.assertIn("9", result["error"])

    def test_missing_sequence_file_is_an_error_line(self):
        home = Home(self)
        result = self.owner(home, "4")
        self.assertEqual(list(result), ["error"])
        self.assertIn("sequence.json", result["error"])

    def test_malformed_sequence_is_an_error_line(self):
        for bad in ("{not json", "[]", json.dumps({"activeAccountNumber": 4})):
            home = Home(self)
            home.sequence(bad)
            result = self.owner(home, "4")
            self.assertEqual(list(result), ["error"], bad)
            self.assertIn("sequence.json", result["error"], bad)

    def test_missing_or_empty_field_is_an_error_line(self):
        bad_entries = [{"organizationUuid": "fake-org-uuid"},
                       {"uuid": "fake-account-uuid"},
                       {"uuid": "", "organizationUuid": "fake-org-uuid"},
                       {"uuid": "fake-account-uuid", "organizationUuid": None},
                       {"uuid": 7, "organizationUuid": "fake-org-uuid"}]
        for entry in bad_entries:
            home = Home(self)
            self.sequence_with(home, {"4": entry})
            result = self.owner(home, "4")
            self.assertEqual(list(result), ["error"], entry)
            self.assertIn("accounts[4]", result["error"], entry)

    def test_non_decimal_account_is_a_usage_error(self):
        home = Home(self)
        self.sequence_with(home, {"4": self.FAKE_ENTRY})
        for bad in ("four", "4a", "1.5", "-1", "+1", "1e3", "", " 4"):
            proc = self.run_cli(home, ["owner", "--account", bad])
            self.assertEqual(proc.returncode, 2, bad)
            self.assertEqual(proc.stdout, "", bad)
            self.assertIn("--account", proc.stderr, bad)
        proc = self.run_cli(home, ["owner"])
        self.assertEqual(proc.returncode, 2)
        self.assertEqual(proc.stdout, "")


if __name__ == "__main__":
    unittest.main()
