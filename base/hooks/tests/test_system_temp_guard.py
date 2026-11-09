"""Tests for literal system temp write targets, independent of the host environment."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "system-temp-guard.py"
SPEC = importlib.util.spec_from_file_location("system_temp_guard", SCRIPT)
GUARD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GUARD)
WIN_ENV = {"USERPROFILE": r"C:\Users\Ada", "LOCALAPPDATA": r"C:\Users\Ada\AppData\Local", "TEMP": r"C:\work\project\.tmp", "TMP": r"D:\scratch"}
POSIX_ENV = {"HOME": "/home/ada", "TMPDIR": "/private/var/folders/abc/T"}
SYSTEM_ENV = {"USERPROFILE": r"C:\Users\Ada", "LOCALAPPDATA": r"C:\Users\Ada\AppData\Local"}


class SystemTempGuardTests(unittest.TestCase):
    def decide(self, tool, value, env, windows=True, cwd=None):
        data = {"tool_name": tool, "cwd": cwd or (r"C:\work\project" if windows else "/work/project"), "tool_input": {"command" if tool == "Bash" else "notebook_path" if tool == "NotebookEdit" else "file_path": value}}
        return GUARD.decision(data, env, windows)

    def check(self, tool, value, denied, windows=True, env=None, cwd=None):
        result = self.decide(tool, value, env or (WIN_ENV if windows else POSIX_ENV), windows, cwd)
        self.assertEqual(bool(result), denied, (tool, value, result))
        if denied:
            self.assertIn(value if tool != "Bash" else "Temp", result)
            self.assertIn(".tmp", result)
            self.assertIn("$TEMP", result)

    def test_deny_tools_and_spellings(self):
        paths = [r"C:\Users\Ada\AppData\Local\Temp\x", "c:/users/ada/appdata/local/temp/x", "/c/Users/Ada/AppData/Local/Temp/x", "~/AppData/Local/Temp/x", "%LOCALAPPDATA%/Temp/x", "$LOCALAPPDATA/Temp/x", "$env:LOCALAPPDATA/Temp/x", r"C:\Users\Ada\AppData\Local\Temp\dir\..\x", r"D:\scratch\x", r"C:\Users\Ada\AppData\Local\Temp\claude\x"]
        for tool in ("Write", "Edit", "NotebookEdit"):
            for path in paths:
                with self.subTest(tool=tool, path=path):
                    self.check(tool, path, True)

    def test_deny_bash_forms(self):
        path = "C:/Users/Ada/AppData/Local/Temp/x"
        commands = [f"echo x > {path}", f"echo x >> '{path}'", f"echo x 2>{path}", f"echo x &> {path}", f"echo x | tee -a {path}", f"mkdir -p {path}", f"touch {path}", f"cp source {path}", f"mv source {path}", f"install source {path}", f"ln source {path}", f"curl -o {path} url", f"wget --output-document={path} url", f"Set-Content -Path {path} value", f"Out-File {path}", f"New-Item -Path {path}"]
        for command in commands:
            with self.subTest(command=command):
                self.check("Bash", command, True)

    def test_allowed(self):
        path = "C:/Users/Ada/AppData/Local/Temp/x"
        for command in ("echo x > $TEMP/x", "touch $TMP", "touch %TEMP%", f"cat {path}", f"ls {path}", f"grep x {path}", f"rm {path}", f"cd {path}", f"cp {path} C:/work/project/x", "touch C:/work/project/.tmp/x", "touch C:/Users/Ada/AppData/Local/Temp2/x", "touch C:/Users/Ada/AppData/Local/Tempfoo/x"):
            with self.subTest(command=command):
                self.check("Bash", command, False)
        self.check("Write", path, False, cwd=r"C:\Users\Ada")
        self.check("Write", "C:/work/project/.tmp/x", False)

    def test_posix_roots(self):
        for path in ("/tmp/x", "/var/tmp/x", "/tmp/a/../x"):
            with self.subTest(path=path):
                self.check("Write", path, True, windows=False)
        self.check("Write", "/tmpfoo/x", False, windows=False)
        self.check("Write", "/tmp/project/.tmp/x", False, windows=False, cwd="/tmp/project")
        self.check("Write", "/tmp/project/other/x", True, windows=False, cwd="/tmp/project")

    def test_macos_tmpdir(self):
        original = GUARD.sys.platform
        try:
            GUARD.sys.platform = "darwin"
            self.check("Write", "/private/var/folders/abc/T/x", True, windows=False)
        finally:
            GUARD.sys.platform = original

    def test_tmp_maps_to_system_temp_on_windows(self):
        # Git Bash mounts /tmp on the bash process TEMP directory, so /tmp/x is a system temp write.
        env = {**SYSTEM_ENV, "TEMP": r"C:\Users\Ada\AppData\Local\Temp"}
        for tool, value in (("Bash", "mkdir /tmp/ed"), ("Bash", "echo x > /tmp/a.py"), ("Bash", "touch /tmp"), ("Write", "/tmp/x.py")):
            with self.subTest(tool=tool, value=value):
                self.assertTrue(self.decide(tool, value, env))

    def test_tmp_maps_to_project_temp_when_temp_is_project_temp(self):
        self.check("Bash", "mkdir /tmp/ed", False)
        self.check("Bash", "echo x > /tmp/a.py", False)
        self.check("Write", "/tmp/x.py", False)

    def test_tmp_prefix_must_be_whole_segment(self):
        env = {**SYSTEM_ENV, "TEMP": r"C:\Users\Ada\AppData\Local\Temp"}
        for path in ("/tmpfoo/x", "/tmp2/x"):
            with self.subTest(path=path):
                self.check("Write", path, False, env=env)

    def test_tmp_fallback_order(self):
        # TEMP wins over TMP, TMP wins over LOCALAPPDATA\Temp.
        project_temp = r"C:\work\project\.tmp"
        self.assertFalse(self.decide("Bash", "mkdir /tmp/ed", {**SYSTEM_ENV, "TEMP": project_temp, "TMP": r"D:\scratch"}))
        self.assertFalse(self.decide("Bash", "mkdir /tmp/ed", {**SYSTEM_ENV, "TMP": project_temp}))
        self.assertTrue(self.decide("Bash", "mkdir /tmp/ed", SYSTEM_ENV))

    def test_tmp_temp_spellings(self):
        for temp in (r"C:\Users\Ada\AppData\Local\Temp\\", "C:/Users/Ada/AppData/Local/Temp/", "/c/Users/Ada/AppData/Local/Temp"):
            with self.subTest(temp=temp):
                self.assertTrue(self.decide("Bash", "mkdir /tmp/ed", {**SYSTEM_ENV, "TEMP": temp}))

    def test_stdin_response(self):
        data = {"tool_name": "Write", "cwd": "/work/project", "tool_input": {"file_path": "/tmp/x"}}
        if sys.platform == "win32":
            data["cwd"] = r"C:\work\project"
            data["tool_input"]["file_path"] = r"C:\Users\Ada\AppData\Local\Temp\x"
        env = {"HOME": "/home/ada", **WIN_ENV}
        result = subprocess.run([sys.executable, "-I", str(SCRIPT)], input=json.dumps(data), text=True, capture_output=True, env=env, check=True)
        self.assertEqual(json.loads(result.stdout)["hookSpecificOutput"]["permissionDecision"], "deny")


if __name__ == "__main__":
    unittest.main()
