"""Guard the cswap account facts tool (cswap-account.py): current account, owner, config dir.

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

MODULE = Path(__file__).resolve().parents[1] / "cswap-account.py"
SPEC = importlib.util.spec_from_file_location("cswap_account", MODULE)
al = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(al)

ACTIVE_ACCOUNT = 4
CLI_TIMEOUT_SECONDS = 60
# Variables that pick the home directory or the Claude config dir; the CLI tests set the ones they need.
HOME_ENV = ("HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "CLAUDE_CONFIG_DIR")


class Home:
    """A throwaway home directory with optional cswap files."""

    def __init__(self, test):
        tmp = tempfile.TemporaryDirectory()
        test.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def sequence(self, text=None, active=ACTIVE_ACCOUNT):
        path = self.root / ".claude-swap-backup" / "sequence.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text if text is not None else json.dumps({"activeAccountNumber": active, "accounts": {"1": {}, "4": {}}}),
                        encoding="utf-8")

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


class ImportTest(unittest.TestCase):
    def test_importing_the_module_does_not_run_the_cli(self):
        spec = importlib.util.spec_from_file_location("cswap_account_import", MODULE)
        module = importlib.util.module_from_spec(spec)
        out = io.StringIO()
        argv = ["cswap-account.py", "batch", "--config-dir", ""]
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


class BatchCliTest(CliRunner):
    """`batch --config-dir <dir>...` prints {"accounts"} as one JSON line."""

    def test_batch_queries_directories(self):
        home = Home(self)
        home.sequence(active=3)
        side = home.side_dir("2-x")
        proc = self.run_cli(home, ["batch", "--config-dir", "", "--config-dir", side, "--config-dir", side])
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(proc.stdout.splitlines()), 1, proc.stdout)
        self.assertEqual(json.loads(proc.stdout),
                         {"accounts": {"": {"present": True, "account": 3}, side: {"present": True, "account": 2}}})

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

    def test_the_process_own_config_dir_is_ignored(self):
        home = Home(self)
        home.sequence()
        proc = self.run_cli(home, ["batch", "--config-dir", ""], own_config_dir=home.side_dir("2-x"))
        self.assertEqual(json.loads(proc.stdout)["accounts"][""], {"present": True, "account": ACTIVE_ACCOUNT})

    def test_the_command_goes_without_a_category_and_a_missing_config_dir_is_a_usage_error(self):
        home = Home(self)
        for argv in (["batch", "--config-dir", "", "--category", "codex"], ["batch"], []):
            proc = self.run_cli(home, argv)
            self.assertNotEqual(proc.returncode, 0, argv)
            self.assertEqual(proc.stdout, "", argv)


class BatchIsolationTest(unittest.TestCase):
    """One directory that raises is reported as {"error": text}; the others keep their answers."""

    def test_a_raising_directory_does_not_fail_the_others(self):
        def account(env=None, home=None):
            directory = (env or {}).get("CLAUDE_CONFIG_DIR", "")
            if directory == "bad":
                raise ValueError("embedded null byte")
            return True, 7
        out = io.StringIO()
        with mock.patch.object(al, "current_account", account), contextlib.redirect_stdout(out):
            self.assertEqual(al.main(["batch", "--config-dir", "good", "--config-dir", "bad", "--config-dir", "fine"]), 0)
        result = json.loads(out.getvalue())
        self.assertEqual(result["accounts"]["good"], {"present": True, "account": 7})
        self.assertEqual(result["accounts"]["fine"], {"present": True, "account": 7})
        self.assertIn("embedded null byte", result["accounts"]["bad"]["error"])


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


class ConfigDirCliTest(CliRunner):
    """`config-dir --account <N>` prints {"dir", "file", "isDefault", "exists"}: where `cswap run N` keeps the config
    file that holds the per-folder consent. The default login's config when N is that login (email + organization
    compared, as cswap's `run` does), else the account's side profile `sessions/<N>-<slug(email)>`."""

    def config_dir(self, home, account, own_config_dir=None):
        proc = self.run_cli(home, ["config-dir", "--account", account], own_config_dir)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(len(proc.stdout.splitlines()), 1, proc.stdout)
        return json.loads(proc.stdout)

    def sequence_with(self, home, accounts, active=1):
        home.sequence(json.dumps({"activeAccountNumber": active, "accounts": accounts}))

    def default_login(self, home, email, org):
        (home.root / ".claude.json").write_text(
            json.dumps({"oauthAccount": {"emailAddress": email, "organizationUuid": org}}), encoding="utf-8")

    def profile(self, home, name, with_file=True):
        directory = home.root / ".claude-swap-backup" / "sessions" / name
        directory.mkdir(parents=True, exist_ok=True)
        if with_file:
            (directory / ".claude.json").write_text("{}", encoding="utf-8")
        return directory

    def test_other_account_than_the_default_login_uses_its_side_profile(self):
        home = Home(self)
        self.sequence_with(home, {"1": {"email": "one@example.test", "organizationUuid": "org-one"},
                                  "3": {"email": "three@example.test", "organizationUuid": "org-three"}})
        self.default_login(home, "one@example.test", "org-one")
        directory = self.profile(home, "3-three_example.test")
        result = self.config_dir(home, "3")
        self.assertEqual(result, {"dir": directory.as_posix(), "file": (directory / ".claude.json").as_posix(),
                                  "isDefault": False, "exists": True})

    def test_the_default_login_uses_the_default_config_whatever_the_active_number_says(self):
        home = Home(self)
        # activeAccountNumber says 1, but the default config belongs to account 3: the config decides.
        self.sequence_with(home, {"1": {"email": "one@example.test", "organizationUuid": "org-one"},
                                  "3": {"email": "three@example.test", "organizationUuid": "org-three"}}, active=1)
        self.default_login(home, "three@example.test", "org-three")
        result = self.config_dir(home, "3")
        self.assertEqual(result["isDefault"], True)
        self.assertEqual(result["dir"], home.root.as_posix())
        self.assertEqual(result["file"], (home.root / ".claude.json").as_posix())
        self.assertEqual(result["exists"], True)
        self.assertEqual(self.config_dir(home, "1")["isDefault"], False)

    def test_same_email_in_another_organization_is_not_the_default_login(self):
        home = Home(self)
        self.sequence_with(home, {"3": {"email": "three@example.test", "organizationUuid": "org-three"}})
        self.default_login(home, "three@example.test", "org-other")
        self.assertEqual(self.config_dir(home, "3")["isDefault"], False)

    def test_missing_organization_on_both_sides_is_the_same_empty_organization(self):
        home = Home(self)
        self.sequence_with(home, {"3": {"email": "three@example.test"}})
        (home.root / ".claude.json").write_text(
            json.dumps({"oauthAccount": {"emailAddress": "three@example.test", "organizationUuid": None}}), encoding="utf-8")
        self.assertEqual(self.config_dir(home, "3")["isDefault"], True)

    def test_the_process_own_config_dir_is_ignored(self):
        home = Home(self)
        self.sequence_with(home, {"3": {"email": "three@example.test", "organizationUuid": "org-three"}})
        self.default_login(home, "three@example.test", "org-three")
        result = self.config_dir(home, "3", own_config_dir=str(home.root / "elsewhere"))
        self.assertEqual(result["isDefault"], True)

    def test_missing_profile_is_reported_not_created(self):
        home = Home(self)
        self.sequence_with(home, {"3": {"email": "three@example.test", "organizationUuid": "org-three"}})
        result = self.config_dir(home, "3")
        self.assertEqual(result["isDefault"], False)
        self.assertEqual(result["exists"], False)
        self.assertFalse((home.root / ".claude-swap-backup" / "sessions").exists())

    def test_profile_dir_without_its_config_file_does_not_exist(self):
        home = Home(self)
        self.sequence_with(home, {"3": {"email": "three@example.test", "organizationUuid": "org-three"}})
        self.profile(home, "3-three_example.test", with_file=False)
        self.assertEqual(self.config_dir(home, "3")["exists"], False)

    def test_slug_keeps_ascii_alphanumerics_dot_underscore_dash_and_replaces_the_rest(self):
        # cswap's slugify_email (claude_swap/session.py): NFC, then every char outside [A-Za-z0-9._-] becomes "_".
        self.assertEqual(al.slugify_email("a.b_c-d+tag@Ex-ample.test"), "a.b_c-d_tag_Ex-ample.test")
        self.assertEqual(al.slugify_email("user name@exämple.test"), "user_name_ex_mple.test")
        # a decomposed "e" + combining accent is composed first (NFC): one character, one underscore.
        self.assertEqual(al.slugify_email("é@x.test"), "__x.test")
        self.assertEqual(al.slugify_email("١@x.test"), "__x.test")

    def test_slug_of_the_email_names_the_profile_dir(self):
        home = Home(self)
        self.sequence_with(home, {"3": {"email": "a+b@example.test", "organizationUuid": "org-three"}})
        directory = self.profile(home, "3-a_b_example.test")
        result = self.config_dir(home, "3")
        self.assertEqual(result["dir"], directory.as_posix())
        self.assertEqual(result["exists"], True)

    def test_leading_zeros_name_the_same_account(self):
        home = Home(self)
        self.sequence_with(home, {"3": {"email": "three@example.test", "organizationUuid": "org-three"}})
        self.assertTrue(self.config_dir(home, "03")["dir"].endswith("/3-three_example.test"))

    def test_legacy_default_config_file_is_the_default_config(self):
        home = Home(self)
        self.sequence_with(home, {"3": {"email": "three@example.test", "organizationUuid": "org-three"}})
        legacy = home.root / ".claude" / ".config.json"
        legacy.parent.mkdir(parents=True)
        legacy.write_text(json.dumps({"oauthAccount": {"emailAddress": "three@example.test",
                                                       "organizationUuid": "org-three"}}), encoding="utf-8")
        result = self.config_dir(home, "3")
        self.assertEqual(result["isDefault"], True)
        self.assertEqual(result["file"], legacy.as_posix())
        self.assertEqual(result["dir"], legacy.parent.as_posix())

    def test_unreadable_default_config_is_not_the_default_login(self):
        home = Home(self)
        self.sequence_with(home, {"3": {"email": "three@example.test", "organizationUuid": "org-three"}})
        (home.root / ".claude.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(self.config_dir(home, "3")["isDefault"], False)

    def test_unknown_account_or_missing_email_is_an_error_line(self):
        home = Home(self)
        result = self.config_dir(home, "3")
        self.assertEqual(list(result), ["error"])
        self.assertIn("sequence.json", result["error"])
        self.sequence_with(home, {"3": {"organizationUuid": "org-three"}, "4": {"email": ""}})
        for account in ("3", "4", "9"):
            result = self.config_dir(home, account)
            self.assertEqual(list(result), ["error"], account)
            self.assertIn(account, result["error"])

    def test_non_decimal_account_is_a_usage_error(self):
        home = Home(self)
        for bad in ("four", "-1", ""):
            proc = self.run_cli(home, ["config-dir", "--account", bad])
            self.assertEqual(proc.returncode, 2, bad)
            self.assertEqual(proc.stdout, "", bad)


if __name__ == "__main__":
    unittest.main()
