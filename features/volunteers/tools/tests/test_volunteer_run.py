"""Tests for volunteer-run.py: no network, no real OpenCode, no real proxy.

Run from the clone root: python -I -m unittest discover -s features/volunteers/tools/tests -v
"""
import http.server
import importlib.util
import io
import json
import re
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
TOOLS = HERE.parent
FAKE_OPENCODE = HERE / "fake_opencode.py"
FAKE_MODELS = HERE / "fake_models.py"
SCRIPT = TOOLS / "volunteer-run.py"
WAIT_SECONDS = 30
STALE_DAYS = 3

def load_fresh_module():
    spec = importlib.util.spec_from_file_location("volunteer_run", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


vr = load_fresh_module()


def stamp(delta=timedelta()):
    return (datetime.now(timezone.utc) - delta).strftime("%Y-%m-%dT%H:%M:%SZ")


class StatusHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        pass


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="volunteer-test-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.jobs = self.tmp / "jobs"
        self.jobs.mkdir()
        self.work = self.tmp / "work"
        self.work.mkdir()
        self.projects_file = self.tmp / "volunteer-projects.json"
        self.projects_file.write_text(json.dumps({"allowed": [str(self.tmp)]}), encoding="utf-8")
        self.server = http.server.HTTPServer(("127.0.0.1", 0), StatusHandler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.scenario = self.tmp / "scenario.json"
        self.log = self.tmp / "calls.jsonl"
        patcher = mock.patch.multiple(
            vr, JOBS_DIR=self.jobs, PROXY_URL=f"http://127.0.0.1:{self.server.server_address[1]}",
            OPENCODE_CMD=[sys.executable, "-I", str(FAKE_OPENCODE)], PROJECTS_FILE=self.projects_file,
            MODELS_SCRIPT=str(FAKE_MODELS), POLL_SECONDS=0.05, IDLE_SECONDS=60, ORPHAN_SECONDS=600,
            HARD_TIMEOUT_SECONDS=600, GLOBAL_RULES=str(self.tmp / "global-rules.md"))
        patcher.start()
        self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ, {"FAKE_SCENARIO": str(self.scenario), "FAKE_LOG": str(self.log),
                                           "FAKE_REFRESH_DIR": str(self.tmp)})
        env.start()
        self.addCleanup(env.stop)
        # the internet is "up" unless a test says otherwise; create=True keeps the older tests meaningful
        net = mock.patch.object(vr, "tcp_reachable", create=True, return_value=True)
        self.tcp = net.start()
        self.addCleanup(net.stop)

    def models(self, *ids, contexts=None, **agents):
        contexts = contexts or {}
        entries = []
        for i in ids:
            entry = {"id": i, "agent": agents.get(i, "full"), "latency_s": 1.0}
            if i in contexts:
                entry["context"] = contexts[i]
            entries.append(entry)
        data = {"checked_at": stamp(), "models": entries, "rejected": []}
        (self.jobs / "models.json").write_text(json.dumps(data), encoding="utf-8")

    def start_thread(self, d):
        t = threading.Thread(target=lambda: vr.Supervisor(d).run(), daemon=True)
        t.start()
        self.addCleanup(t.join, WAIT_SECONDS)
        return t

    def wait_for(self, d, field, value):
        deadline = time.time() + WAIT_SECONDS
        while vr.read_json(d / "state.json").get(field) != value and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(vr.read_json(d / "state.json").get(field), value)

    def scene(self, **by_model):
        self.scenario.write_text(json.dumps({k.replace("__", "/"): v for k, v in by_model.items()}),
                                 encoding="utf-8")

    def make_job(self, read_only=False, prompt="do the task"):
        job = "20260101-000000-abcd"
        d = self.jobs / job
        d.mkdir()
        (d / "prompt.md").write_text(prompt, encoding="utf-8")
        (d / "heartbeat").touch()
        vr.write_json(d / "state.json", {
            "job": job, "slug": "pending", "effort": "-", "read_only": read_only, "cwd": str(self.work),
            "status": "starting", "created": time.time(), "updated": time.time(), "switches": 0, "steps": 0,
            "notes": []})
        return d

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def run_job(self, d):
        vr.Supervisor(d).run()
        return vr.read_json(d / "state.json")


class ReadJsonTests(Base):
    def test_permission_error_on_first_read_is_retried(self):
        path = self.tmp / "state.json"
        path.write_text('{"a": 1}', encoding="utf-8")
        real = Path.read_text
        calls = []

        def flaky(self_path, *args, **kwargs):
            calls.append(1)
            if len(calls) == 1:
                raise PermissionError("replace in progress")
            return real(self_path, *args, **kwargs)

        with mock.patch.object(Path, "read_text", flaky):
            self.assertEqual(vr.read_json(path), {"a": 1})

    def test_missing_file_returns_default_without_waiting(self):
        started = time.time()
        self.assertEqual(vr.read_json(self.tmp / "none.json", "dflt"), "dflt")
        self.assertLess(time.time() - started, vr.REPLACE_RETRY_SECONDS)

    def test_permanent_permission_error_returns_default(self):
        path = self.tmp / "state.json"
        path.write_text("{}", encoding="utf-8")
        with mock.patch.object(Path, "read_text", side_effect=PermissionError), \
                mock.patch.object(vr.time, "sleep"):
            self.assertEqual(vr.read_json(path, "dflt"), "dflt")


class WhitelistTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="volunteer-test-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.projects_file = self.tmp / "volunteer-projects.json"
        self.allowed = self.tmp / "allowed-project"
        self.allowed.mkdir()
        self.allowed2 = self.tmp / "allowed-project2"
        self.allowed2.mkdir()
        self.other = self.tmp / "other-project"
        self.other.mkdir()
        self.file_patch = mock.patch.object(vr, "PROJECTS_FILE", self.projects_file)
        self.file_patch.start()
        self.addCleanup(self.file_patch.stop)
        self.write_allowed(self.allowed)

    def write_allowed(self, *paths):
        self.projects_file.write_text(json.dumps({"allowed": [str(path) for path in paths]}), encoding="utf-8")

    def refused(self, path):
        with self.assertRaises(vr.Fail):
            vr.check_cwd(path)

    def test_allowed_root_accepted(self):
        self.assertEqual(vr.check_cwd(self.allowed), self.allowed)

    def test_subdirectory_accepted(self):
        child = self.allowed / "nested"
        child.mkdir()
        self.assertEqual(vr.check_cwd(child), child)

    def test_missing_file_refuses_and_names_file(self):
        self.projects_file.unlink()
        with self.assertRaises(vr.Fail) as error:
            vr.check_cwd(self.allowed)
        self.assertIn(str(self.projects_file), str(error.exception))
        self.assertIn("allowed", str(error.exception))

    def test_malformed_json_refuses(self):
        self.projects_file.write_text("{bad json", encoding="utf-8")
        with self.assertRaises(vr.Fail) as error:
            vr.check_cwd(self.allowed)
        self.assertIn(str(self.projects_file), str(error.exception))
        self.assertIn("JSON", str(error.exception))

    def test_unreadable_file_refuses_and_names_file(self):
        with mock.patch.object(Path, "read_text", side_effect=PermissionError("access denied")):
            with self.assertRaises(vr.Fail) as error:
                vr.check_cwd(self.allowed)
        self.assertIn(str(self.projects_file), str(error.exception))
        self.assertIn("access denied", str(error.exception))

    def test_wrong_allowed_type_refuses(self):
        self.projects_file.write_text(json.dumps({"allowed": str(self.allowed)}), encoding="utf-8")
        with self.assertRaises(vr.Fail) as error:
            vr.check_cwd(self.allowed)
        self.assertIn(str(self.projects_file), str(error.exception))
        self.assertIn("list of strings", str(error.exception))

    def test_unknown_folder_refused(self):
        self.refused("C:/Windows")
        self.refused(str(Path.home() / ".claude"))

    def test_dotdot_traversal_refused(self):
        self.refused(self.allowed / "../other-project")
        self.refused(self.allowed / "../../Windows")

    def test_prefix_trap_refused(self):
        self.refused(str(self.allowed) + "-evil")
        self.refused(self.allowed2)

    def test_start_refuses_without_creating_a_job(self):
        jobs = Path(tempfile.mkdtemp(prefix="volunteer-test-"))
        self.addCleanup(shutil.rmtree, jobs, True)
        prompt = jobs / "p.md"
        prompt.write_text("task", encoding="utf-8")
        isolated_home = jobs / "home"
        isolated_home.mkdir()
        r = subprocess.run([sys.executable, "-I", str(SCRIPT), "start", "--prompt-file", str(prompt),
                            "--cwd", str(jobs)], capture_output=True, text=True,
                           env=dict(os.environ, USERPROFILE=str(isolated_home), HOME=str(isolated_home),
                                    VOLUNTEER_JOBS_DIR=str(jobs / "run-jobs")))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("REFUSED", r.stderr)
        self.assertEqual(list((jobs / "jobs").glob("*")) if (jobs / "jobs").exists() else [], [])

    def test_prompt_path_is_under_cwd_tmp(self):
        r = subprocess.run([sys.executable, "-I", str(SCRIPT), "prompt-path", "--cwd", str(HERE)],
                           capture_output=True, text=True)
        out = Path(r.stdout.strip())
        self.assertEqual(out.parent.name, ".tmp")
        self.assertTrue(out.name.startswith("volunteer-prompt-") and out.name.endswith(".md"))


class TranslateTests(unittest.TestCase):
    def test_text_becomes_agent_message(self):
        out = vr.translate({"type": "text", "part": {"id": "x", "text": "hello"}})
        self.assertEqual(out[0]["type"], "item.completed")
        self.assertEqual(out[0]["item"]["type"], "agent_message")
        self.assertEqual(out[0]["item"]["text"], "hello")

    def test_blank_text_skipped(self):
        self.assertEqual(vr.translate({"type": "text", "part": {"text": "  "}}), [])

    def test_tool_use_becomes_started_and_completed(self):
        out = vr.translate({"type": "tool_use", "part": {"callID": "c1", "tool": "bash", "state": {
            "status": "completed", "input": {"command": "ls -la"}}}})
        self.assertEqual([e["type"] for e in out], ["item.started", "item.completed"])
        for e in out:
            self.assertEqual(e["item"]["type"], "command_execution")
            self.assertEqual(e["item"]["command"], "ls -la")
            self.assertEqual(e["item"]["id"], "c1")

    def test_file_tool_described_by_path(self):
        out = vr.translate({"type": "tool_use", "part": {"callID": "c2", "tool": "read", "state": {
            "status": "completed", "input": {"filePath": "a.txt"}}}})
        self.assertEqual(out[0]["item"]["command"], "read a.txt")

    def test_error_becomes_failure_event(self):
        out = vr.translate({"type": "error", "error": {"name": "APIError", "data": {
            "message": "rate limited", "statusCode": 429}}})
        self.assertEqual(out[0]["type"], "turn.failed")
        self.assertIn("429", out[0]["error"]["message"])
        self.assertIn("rate limited", out[0]["error"]["message"])

    def test_step_events(self):
        self.assertEqual(vr.translate({"type": "step_start"})[0]["type"], "turn.started")
        self.assertEqual(vr.translate({"type": "step_finish", "part": {"reason": "stop"}})[0]["type"],
                         "turn.completed")
        self.assertEqual(vr.translate({"type": "step_finish", "part": {"reason": "tool-calls"}}), [])


class ConfigTests(Base):
    def state(self, read_only=False):
        return {"cwd": str(self.work), "read_only": read_only}

    def test_read_only_denies_edit_and_limits_bash(self):
        perm = vr.permission(True)
        self.assertEqual(perm["edit"], "deny")
        self.assertEqual(perm["bash"]["*"], "deny")
        self.assertEqual(perm["bash"]["git status *"], "allow")
        self.assertNotIn("git commit", [k for k, v in perm["bash"].items() if v == "allow"])

    def test_write_mode_denies_commit_and_push(self):
        perm = vr.permission(False)
        self.assertEqual(perm["edit"], "allow")
        self.assertEqual(perm["bash"]["git commit *"], "deny")
        self.assertEqual(perm["bash"]["git push"], "deny")
        self.assertEqual(perm["external_directory"], "deny")

    def test_config_uses_env_reference_for_token(self):
        cfg = json.dumps(vr.build_config(self.state(), [{"id": "a/b"}], {"id": "a/b", "agent": "full"}))
        self.assertIn("{env:FLP_TOKEN}", cfg)
        env = vr.build_env(self.state(), [{"id": "a/b"}], {"id": "a/b", "agent": "full"}, "secret-token")
        self.assertEqual(env["FLP_TOKEN"], "secret-token")
        self.assertNotIn("secret-token", env["OPENCODE_CONFIG_CONTENT"])
        self.assertEqual(env["PWD"], str(self.work))

    def test_full_agent_drops_global_claude_md_and_adds_rules(self):
        (self.work / "CLAUDE.md").write_text("project rules", encoding="utf-8")
        entry = {"id": "a/b", "agent": "full"}
        env = vr.build_env(self.state(), [entry], entry, "t")
        self.assertEqual(env["OPENCODE_DISABLE_CLAUDE_CODE_PROMPT"], "1")
        self.assertNotIn("OPENCODE_DISABLE_CLAUDE_CODE", env)
        instructions = json.loads(env["OPENCODE_CONFIG_CONTENT"])["instructions"]
        self.assertIn(str(self.work / "CLAUDE.md"), instructions)
        self.assertIn(vr.GLOBAL_RULES, instructions)

    def test_real_module_constants_serialize_into_the_config(self):
        # The fixture patches GLOBAL_RULES with a str; the module's own constant must serialize too.
        real = load_fresh_module()
        entry = {"id": "a/b", "agent": "full"}
        env = real.build_env({"cwd": str(self.work), "read_only": False}, [entry], entry, "t")
        rules = json.loads(env["OPENCODE_CONFIG_CONTENT"])["instructions"][0]
        self.assertIsInstance(rules, str)
        self.assertEqual(rules, (Path.home() / ".codex" / "AGENTS.md").as_posix())

    def test_minimal_agent_disables_claude_code_files(self):
        entry = {"id": "a/b", "agent": "minimal"}
        env = vr.build_env(self.state(), [entry], entry, "t")
        self.assertEqual(env["OPENCODE_DISABLE_CLAUDE_CODE"], "1")
        cfg = json.loads(env["OPENCODE_CONFIG_CONTENT"])
        self.assertIn("minimal", cfg["agent"])
        self.assertNotIn("instructions", cfg)


class SupervisorTests(Base):
    def test_report_contract_in_prompt(self):
        self.assertIn("More work than expected is never a reason to stop", vr.RUN_RULES)
        self.assertIn("Blocked by: for blocked", vr.RUN_RULES)

    def test_malformed_recovery_and_restart(self):
        self.models("openrouter/a")
        for first, second, prior, expected, count in [("bad", "STATUS: blocked\nBlocked by: access: a credential is missing", 0, "blocked", 2),
                                                       ("STATUS: blocked\nBlocked by: unfinished", "STATUS: blocked\nBlocked by: access:", 0, "malformed", 2),
                                                       ("bad", "bad again", 0, "malformed", 2),
                                                       ("bad again", "unused", 1, "malformed", 1)]:
            with self.subTest(expected=expected, prior=prior):
                self.scene(openrouter__a=[{"text": first}])
                d = self.make_job()
                state = vr.read_json(d / "state.json")
                state["malformed_follow_ups"] = prior
                vr.write_json(d / "state.json", state)
                real_run_once = vr.Supervisor.run_once
                calls = []
                def run_once(sup, *args):
                    result = real_run_once(sup, *args)
                    calls.append(1)
                    if len(calls) == 1:
                        self.scene(openrouter__a=[{"text": second}])
                    return result
                with mock.patch.object(vr.Supervisor, "run_once", run_once):
                    st = self.run_job(d)
                self.assertEqual(st["status"], expected, st)
                self.assertEqual(len(calls), count)
                if count == 2:
                    self.assertIn("STATUS", self.calls()[-1]["message"])
                if expected == "malformed":
                    self.assertTrue(st["report_error"])
                shutil.rmtree(d)

    def test_run_with_the_modules_own_rules_path_reaches_the_fake_opencode(self):
        self.models("openrouter/a")
        self.scene(openrouter__a=[{"text": "All done.\nSTATUS: done"}])
        d = self.make_job()
        with mock.patch.object(vr, "GLOBAL_RULES", load_fresh_module().GLOBAL_RULES):
            st = self.run_job(d)
        self.assertEqual(st["status"], "done")
        self.assertEqual(len(self.calls()), 1)

    def test_success_writes_result_and_event_stream(self):
        self.models("openrouter/a")
        self.scene(openrouter__a=[{"text": "starting"}, {"tool": "echo hi"},
                                  {"write": str(self.work / "hello.txt"), "content": "hi"},
                                  {"text": "All done.\nSTATUS: done"}])
        d = self.make_job()
        st = self.run_job(d)
        self.assertEqual(st["status"], "done")
        self.assertEqual(st["slug"], "openrouter/a")
        self.assertEqual(st["effort"], "-")
        self.assertIn("STATUS: done", (d / "last.md").read_text(encoding="utf-8"))
        self.assertEqual((self.work / "hello.txt").read_text(), "hi")
        events = [json.loads(x) for x in (d / "events.jsonl").read_text(encoding="utf-8").splitlines()]
        types = [(e["type"], (e.get("item") or {}).get("type")) for e in events]
        self.assertIn(("item.started", "command_execution"), types)
        self.assertIn(("item.completed", "command_execution"), types)
        self.assertIn(("item.completed", "agent_message"), types)
        raw = (d / "opencode-events.jsonl").read_text(encoding="utf-8")
        self.assertIn('"tool_use"', raw)
        call = self.calls()[0]
        self.assertEqual(call["model"], "openrouter/a")
        self.assertEqual(call["pwd"], str(self.work))
        self.assertEqual(call["cwd"], str(self.work))
        self.assertIn("do the task", call["message"])
        self.assertNotIn(vr.proxy_token(), " ".join(call["argv"]))

    def test_question_status(self):
        self.models("openrouter/a")
        self.scene(openrouter__a=[{"text": "STATUS: question\nQuestions: Which API? A or B; recommend A."}])
        self.assertEqual(self.run_job(self.make_job())["status"], "question")

    def test_switch_on_error_event(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"error": "rate limit exceeded", "status": 429}, {"sleep": 60}],
                   openrouter__b=[{"text": "ok\nSTATUS: done"}])
        d = self.make_job()
        st = self.run_job(d)
        self.assertEqual(st["status"], "done")
        self.assertEqual(st["slug"], "openrouter/b")
        self.assertEqual(st["switches"], 1)
        self.assertTrue(any("model openrouter/a failed" in n and "switching to openrouter/b" in n and "429" in n
                            for n in st["notes"]), st["notes"])
        calls = self.calls()
        self.assertEqual([c["model"] for c in calls], ["openrouter/a", "openrouter/b"])
        self.assertTrue(calls[1]["continued"])
        self.assertEqual(calls[1]["session"], "ses_fake")
        self.assertIn("different model", calls[1]["message"])

    def test_idle_limit_outlasts_gateway_deadline(self):
        # freellmpool 0.13.0 buffers tool-calling replies for up to 540 s (proxy.py _AGENT_UPSTREAM_TIMEOUT);
        # declaring a hang sooner kills a model that is still thinking
        with mock.patch.dict(os.environ):
            os.environ.pop("VOLUNTEER_IDLE_SECONDS", None)
            fresh = load_fresh_module()
        self.assertGreater(fresh.IDLE_SECONDS, 540)

    def test_switch_on_nonzero_exit(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"exit": 3}], openrouter__b=[{"text": "ok\nSTATUS: done"}])
        st = self.run_job(self.make_job())
        self.assertEqual(st["status"], "done")
        self.assertEqual(st["slug"], "openrouter/b")
        self.assertTrue(any("exit code 3" in n for n in st["notes"]), st["notes"])

    def test_switch_on_hang(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"sleep": 60}], openrouter__b=[{"text": "ok\nSTATUS: done"}])
        with mock.patch.object(vr, "IDLE_SECONDS", 1):
            st = self.run_job(self.make_job())
        self.assertEqual(st["status"], "done")
        self.assertEqual(st["slug"], "openrouter/b")
        self.assertTrue(any("no events for" in n for n in st["notes"]), st["notes"])

    def test_all_models_exhausted_fails(self):
        self.models("openrouter/a", "openrouter/b")
        # permanent per-job failures (4xx) remove a model for good; transient ones only cool it down
        self.scene(openrouter__a=[{"error": "bad request", "status": 400}, {"sleep": 60}],
                   openrouter__b=[{"error": "model not found", "status": 404}, {"sleep": 60}])
        st = self.run_job(self.make_job())
        self.assertEqual(st["status"], "blocked")
        self.assertIn("no free models available", st["error"])
        self.assertIn("model not found", st["error"])

    def test_empty_cache_fails_with_reason(self):
        data = {"checked_at": stamp(), "models": [], "rejected": [{"id": "x/y", "reason": "no tools"}]}
        (self.jobs / "models.json").write_text(json.dumps(data), encoding="utf-8")
        st = self.run_job(self.make_job())
        self.assertEqual(st["status"], "blocked")
        self.assertIn("no free models available", st["error"])
        self.assertIn("no tools", st["error"])

    def test_minimal_agent_flag_passed(self):
        self.models("groq/m", **{"groq/m": "minimal"})
        self.scene(groq__m=[{"text": "ok\nSTATUS: done"}])
        self.run_job(self.make_job())
        call = self.calls()[0]
        self.assertEqual(call["agent"], "minimal")
        self.assertEqual(call["disable_all"], "1")

    def test_cancel_kills_the_process_tree(self):
        self.models("openrouter/a")
        child = self.tmp / "child.pid"
        self.scene(openrouter__a=[{"child": str(child)}, {"sleep": 120}])
        d = self.make_job()
        t = threading.Thread(target=lambda: vr.Supervisor(d).run(), daemon=True)
        t.start()
        deadline = time.time() + WAIT_SECONDS
        while not child.exists() and time.time() < deadline:
            time.sleep(0.1)
        self.assertTrue(child.exists(), "fake opencode never started its child")
        time.sleep(0.2)
        child_pid = int(child.read_text())
        parent_pid = vr.read_json(d / "state.json")["opencode_pid"]
        self.addCleanup(vr.kill_tree, child_pid)
        self.addCleanup(vr.kill_tree, parent_pid)
        self.assertTrue(vr.pid_alive(child_pid))
        (d / "cancel").touch()
        t.join(WAIT_SECONDS)
        self.assertFalse(t.is_alive())
        self.assertEqual(vr.read_json(d / "state.json")["status"], "cancelled")
        deadline = time.time() + 10
        while vr.pid_alive(child_pid) and time.time() < deadline:
            time.sleep(0.1)
        self.assertFalse(vr.pid_alive(child_pid), "the child survived the cancel")
        self.assertFalse(vr.pid_alive(parent_pid))

    def test_orphaned_without_heartbeat(self):
        self.models("openrouter/a")
        self.scene(openrouter__a=[{"sleep": 60}])
        d = self.make_job()
        old = time.time() - 3600
        os.utime(d / "heartbeat", (old, old))
        st = self.run_job(d)
        self.assertEqual(st["status"], "orphaned")

    def test_reply_continues_the_session_on_the_same_model(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"text": "first\nSTATUS: question"}],
                   openrouter__b=[{"text": "wrong model"}])
        d = self.make_job()
        vr.Supervisor(d).run()
        st = vr.read_json(d / "state.json")
        st["slug"] = "openrouter/a"
        vr.write_json(d / "state.json", st)
        (d / "reply.md").write_text("use REST", encoding="utf-8")
        self.scene(openrouter__a=[{"text": "second\nSTATUS: done"}])
        st = self.run_job(d)
        self.assertEqual(st["status"], "done")
        last = self.calls()[-1]
        self.assertEqual(last["model"], "openrouter/a")
        self.assertTrue(last["continued"])
        self.assertIn("use REST", last["message"])


class ModelsCacheTests(Base):
    def payload(self, *ids):
        data = {"checked_at": stamp(), "models": [{"id": i, "agent": "full", "latency_s": 1.0} for i in ids],
                "rejected": []}
        (self.tmp / "refresh-payload.json").write_text(json.dumps(data), encoding="utf-8")

    def test_missing_cache_refreshes_synchronously(self):
        self.payload("openrouter/fresh")
        cache = vr.ensure_models()
        self.assertTrue((self.tmp / "refresh-ran").exists())
        self.assertEqual(cache["models"][0]["id"], "openrouter/fresh")
        self.assertIn("--proxy-url", (self.tmp / "refresh-ran").read_text())

    def test_fresh_cache_is_not_refreshed(self):
        self.models("openrouter/a")
        self.payload("openrouter/fresh")
        cache = vr.ensure_models()
        time.sleep(1)
        self.assertFalse((self.tmp / "refresh-ran").exists())
        self.assertEqual(cache["models"][0]["id"], "openrouter/a")

    def test_stale_cache_is_used_now_and_refreshed_in_background(self):
        data = {"checked_at": stamp(timedelta(days=STALE_DAYS)),
                "models": [{"id": "openrouter/old", "agent": "full", "latency_s": 1.0}], "rejected": []}
        (self.jobs / "models.json").write_text(json.dumps(data), encoding="utf-8")
        self.payload("openrouter/fresh")
        spawned = []
        real_spawn = vr.spawn_detached

        def keep_proc(*args, **kwargs):
            proc = real_spawn(*args, **kwargs)
            spawned.append(proc)
            return proc

        def reap():
            for proc in spawned:
                try:
                    proc.wait(timeout=WAIT_SECONDS)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()

        self.addCleanup(reap)
        with mock.patch.object(vr, "spawn_detached", keep_proc):
            cache = vr.ensure_models()
        self.assertEqual(cache["models"][0]["id"], "openrouter/old")
        self.assertEqual(len(spawned), 1)
        try:
            self.assertEqual(spawned[0].wait(timeout=WAIT_SECONDS), 0, "background refresh failed")
        except subprocess.TimeoutExpired:
            self.fail("background refresh did not finish")
        deadline = time.time() + WAIT_SECONDS
        while not (self.tmp / "refresh-ran").exists() and time.time() < deadline:
            time.sleep(0.2)
        self.assertTrue((self.tmp / "refresh-ran").exists(), "background refresh never ran")
        time.sleep(0.5)
        self.assertEqual(vr.read_json(self.jobs / "models.json")["models"][0]["id"], "openrouter/fresh")

    def test_missing_cache_and_failed_refresh_raises(self):
        (self.tmp / "refresh-payload.json").unlink(missing_ok=True)
        with self.assertRaises(vr.Fail):
            vr.ensure_models()


STARTING_STALE_SECONDS = 100  # above the 60 s the wait gives a supervisor to start
REPLY_STATUSES = ("done", "question", "blocked", "malformed", "limit")
NOT_REPLYABLE_STATUSES = ("running", "starting", "cancelled", "orphaned")
BLOCKED_REPORT = "Stopped.\nSTATUS: blocked\nBlocked by: access: the access key is missing"
REPORT_TEXT = "Result in short.\nSTATUS: done\nDone: - the secret report body\nChanged files: a.py"


class JobLifecycleTests(Base):
    """cmd_wait, cmd_reply, the malformed counter across turns and the progress digest."""

    def job_with(self, **fields):
        d = self.make_job()
        st = vr.read_json(d / "state.json")
        st.update(session_id="session", slug="openrouter/a", **fields)
        vr.write_json(d / "state.json", st)
        return d

    def wait(self, d, interval=0):
        out = io.StringIO()
        with redirect_stdout(out):
            vr.cmd_wait(mock.Mock(job="20260101-000000-abcd", interval=interval))
        return vr.read_json(d / "state.json"), out.getvalue()

    def test_wait_ends_a_job_whose_supervisor_died_as_blocked(self):
        d = self.job_with(status="running", supervisor_pid=None)
        state, out = self.wait(d)
        self.assertEqual(state["status"], "blocked")
        self.assertEqual(state["error"], "supervisor process died")
        self.assertNotIn("still running", out)

    def test_wait_ends_a_job_whose_supervisor_never_started_as_blocked(self):
        d = self.job_with(status="starting", created=time.time() - STARTING_STALE_SECONDS)
        state, out = self.wait(d, interval=STARTING_STALE_SECONDS)
        self.assertEqual(state["status"], "blocked")
        self.assertIn("supervisor did not start", state["error"])

    def test_reply_accepts_every_status_a_job_can_end_with_a_session(self):
        for status in REPLY_STATUSES:
            with self.subTest(status=status):
                d = self.job_with(status=status, error="old")
                with mock.patch.object(vr, "spawn_supervisor") as spawn, mock.patch.object(vr, "cmd_wait"), \
                        mock.patch.object(vr, "take_prompt", return_value="go"), redirect_stdout(io.StringIO()):
                    vr.cmd_reply(mock.Mock(job="20260101-000000-abcd", prompt_file="unused"))
                spawn.assert_called_once()
                self.assertEqual(vr.read_json(d / "state.json")["status"], "starting")
                self.assertIn("go", (d / "reply.md").read_text(encoding="utf-8"))
                shutil.rmtree(d)

    def test_reply_refuses_a_job_that_has_not_finished(self):
        for status in NOT_REPLYABLE_STATUSES:
            with self.subTest(status=status):
                d = self.job_with(status=status)
                with mock.patch.object(vr, "spawn_supervisor") as spawn, self.assertRaises(SystemExit):
                    vr.cmd_reply(mock.Mock(job="20260101-000000-abcd", prompt_file="unused"))
                spawn.assert_not_called()
                shutil.rmtree(d)

    def run_turn(self, d, first, second):
        """Runs the supervisor over a bad first report; the second report is what the follow-up gets."""
        self.models("openrouter/a")
        self.scene(openrouter__a=[{"text": first}])
        real_run_once = vr.Supervisor.run_once
        calls = []

        def run_once(sup, *args):
            result = real_run_once(sup, *args)
            calls.append(1)
            if len(calls) == 1:
                self.scene(openrouter__a=[{"text": second}])
            return result

        with mock.patch.object(vr.Supervisor, "run_once", run_once):
            st = self.run_job(d)
        return st, len(calls)

    def test_a_reply_turn_gets_its_own_malformed_follow_up(self):
        d = self.job_with(status="starting", malformed_follow_ups=1)
        (d / "reply.md").write_text("the answer", encoding="utf-8")
        st, calls = self.run_turn(d, "bad", "STATUS: done")
        self.assertEqual(calls, 2)
        self.assertEqual(st["status"], "done", st)

    def test_a_second_malformed_report_in_a_reply_turn_ends_the_job(self):
        d = self.job_with(status="starting", malformed_follow_ups=1)
        (d / "reply.md").write_text("the answer", encoding="utf-8")
        st, calls = self.run_turn(d, "bad", "bad again")
        self.assertEqual(calls, 2)
        self.assertEqual(st["status"], "malformed")

    def test_a_restart_without_a_reply_keeps_the_malformed_counter(self):
        d = self.job_with(status="starting", malformed_follow_ups=1)
        st, calls = self.run_turn(d, "bad", "STATUS: done")
        self.assertEqual(calls, 1)
        self.assertEqual(st["status"], "malformed")

    def final_digest(self, d):
        return vr.digest(d, vr.read_json(d / "state.json"), [], True)

    def test_final_digest_shows_the_report_of_every_report_outcome(self):
        for status in ("done", "question", "blocked", "malformed"):
            with self.subTest(status=status):
                d = self.job_with(status=status, started=time.time(), ended=time.time(),
                                  report_error="no STATUS line")
                (d / "last.md").write_text(BLOCKED_REPORT, encoding="utf-8")
                out = self.final_digest(d)
                self.assertIn("Blocked by: access: the access key", out)
                self.assertNotIn("error:", out)
                self.assertEqual("report problem: no STATUS line" in out, status == "malformed")
                shutil.rmtree(d)

    def test_final_digest_keeps_the_error_when_the_launcher_failed(self):
        d = self.job_with(status="blocked", started=time.time(), ended=time.time(), error="supervisor process died")
        (d / "last.md").write_text(BLOCKED_REPORT, encoding="utf-8")
        out = self.final_digest(d)
        self.assertIn("error: supervisor process died", out)
        self.assertNotIn("the access key", out)

    def test_a_report_outcome_clears_a_stale_error(self):
        for first, status in [("STATUS: blocked\nBlocked by: access: the access key", "blocked"), ("bad", "malformed")]:
            with self.subTest(status=status):
                d = self.job_with(status="starting", error="supervisor process died", malformed_follow_ups=1)
                st, _ = self.run_turn(d, first, "unused")
                self.assertEqual(st["status"], status)
                self.assertIsNone(st["error"])
                shutil.rmtree(d)

    def test_progress_digest_never_shows_a_message_with_the_report(self):
        d = self.make_job()
        st = vr.read_json(d / "state.json")
        st.update(status="running", slug="openrouter/a", started=time.time())
        events = [{"type": "item.completed", "item": {"type": "agent_message", "text": text}}
                  for text in ("reading the tests", REPORT_TEXT)]
        progress = vr.digest(d, st, events, False)
        self.assertIn("reading the tests", progress)
        self.assertNotIn("secret report body", progress)
        self.assertNotIn("STATUS", progress)


class ClientTests(Base):
    def test_start_creates_job_and_prints_start_line(self):
        self.models("openrouter/a")
        prompt = self.work / "p.md"
        prompt.write_text("make hello", encoding="utf-8")
        args = mock.Mock(prompt_file=str(prompt), cwd=str(self.work), read_only=True)
        out = io.StringIO()
        with mock.patch.object(vr, "spawn_supervisor") as spawn, redirect_stdout(out):
            vr.cmd_start(args)
        job = out.getvalue().split()[2]
        self.assertRegex(job, r"^\d{8}-\d{6}-[0-9a-f]+$")
        self.assertIn(f"volunteer job {job} started: openrouter/a, cwd {self.work}", out.getvalue())
        self.assertIn(f"(still running; call: wait {job})", out.getvalue())
        spawn.assert_called_once()
        st = vr.read_json(self.jobs / job / "state.json")
        self.assertEqual((st["status"], st["slug"], st["effort"], st["read_only"]),
                         ("starting", "openrouter/a", "-", True))
        self.assertIn("STATUS:", (self.jobs / job / "prompt.md").read_text(encoding="utf-8"))

    def test_start_deletes_a_relay_prompt_file(self):
        self.models("openrouter/a")
        prompt = self.work / "volunteer-prompt-1.md"
        prompt.write_text("task", encoding="utf-8")
        args = mock.Mock(prompt_file=str(prompt), cwd=str(self.work), read_only=False)
        with mock.patch.object(vr, "spawn_supervisor"), redirect_stdout(io.StringIO()):
            vr.cmd_start(args)
        self.assertFalse(prompt.exists())

    def test_wait_prints_final_digest(self):
        d = self.make_job()
        st = vr.read_json(d / "state.json")
        st.update(status="done", slug="openrouter/a", started=time.time(), ended=time.time())
        vr.write_json(d / "state.json", st)
        (d / "last.md").write_text("report text\nSTATUS: done\n", encoding="utf-8")
        out = io.StringIO()
        with redirect_stdout(out):
            vr.cmd_wait(mock.Mock(job=st["job"], interval=1))
        text = out.getvalue()
        self.assertIn(f"volunteer job {st['job']} · done · openrouter/a ·", text)
        self.assertIn("report text", text)
        self.assertNotIn("still running", text)

    def test_wait_on_running_job_prints_marker(self):
        d = self.make_job()
        st = vr.read_json(d / "state.json")
        st.update(status="running", supervisor_pid=os.getpid(), started=time.time())
        vr.write_json(d / "state.json", st)
        out = io.StringIO()
        with redirect_stdout(out):
            vr.cmd_wait(mock.Mock(job=st["job"], interval=0))
        self.assertIn(f"(still running; call: wait {st['job']})", out.getvalue())


class InfraHealthTests(Base):
    """A failed run blames the model only when the gateway and the internet are healthy."""

    def setUp(self):
        super().setUp()
        self.gateway_up = True
        self.restarts = 0
        self.on_restart = None
        patches = [
            mock.patch.object(vr, "proxy_up", lambda token=None: self.gateway_up),
            mock.patch.object(vr, "ensure_proxy", self.fake_ensure_proxy),
            mock.patch.object(vr, "NETWORK_POLL_SECONDS", 0.05, create=True),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def fake_ensure_proxy(self):
        self.restarts += 1
        self.gateway_up = True
        if self.restarts > 1 and self.on_restart:
            self.on_restart()
        return "test-token"

    def start_thread(self, d):
        t = threading.Thread(target=lambda: vr.Supervisor(d).run(), daemon=True)
        t.start()
        self.addCleanup(t.join, WAIT_SECONDS)
        return t

    def wait_for(self, d, field, value):
        deadline = time.time() + WAIT_SECONDS
        while vr.read_json(d / "state.json").get(field) != value and time.time() < deadline:
            time.sleep(0.05)
        self.assertEqual(vr.read_json(d / "state.json").get(field), value)

    def test_gateway_down_restarts_and_retries_the_same_model(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"error": "connection refused", "status": 500}, {"sleep": 60}],
                   openrouter__b=[{"text": "wrong\nSTATUS: done"}])
        self.on_restart = lambda: self.scene(openrouter__a=[{"text": "ok\nSTATUS: done"}])
        real_run_once = vr.Supervisor.run_once
        first = []

        def run_once(sup, *args, **kwargs):
            result = real_run_once(sup, *args, **kwargs)
            if not first:
                first.append(1)
                self.gateway_up = False
            return result

        with mock.patch.object(vr.Supervisor, "run_once", run_once):
            st = self.run_job(self.make_job())
        self.assertEqual(st["status"], "done", st)
        self.assertEqual(st["slug"], "openrouter/a")
        self.assertEqual(st["switches"], 0)
        self.assertEqual([c["model"] for c in self.calls()], ["openrouter/a", "openrouter/a"])
        self.assertTrue(any("gateway was down, restarted; retrying openrouter/a" in n for n in st["notes"]),
                        st["notes"])
        self.assertEqual(self.restarts, 2)

    def test_gateway_dying_three_times_fails_the_job(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"exit": 3}], openrouter__b=[{"exit": 3}])
        real_run_once = vr.Supervisor.run_once

        def run_once(sup, *args, **kwargs):
            result = real_run_once(sup, *args, **kwargs)
            self.gateway_up = False
            return result

        with mock.patch.object(vr.Supervisor, "run_once", run_once):
            st = self.run_job(self.make_job())
        self.assertEqual(st["status"], "blocked", st)
        self.assertIn("gateway keeps dying (see proxy.log)", st["error"])
        self.assertEqual(st["switches"], 0)
        self.assertEqual({c["model"] for c in self.calls()}, {"openrouter/a"})

    def test_gateway_that_cannot_restart_fails_the_job(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"exit": 3}], openrouter__b=[{"text": "ok\nSTATUS: done"}])
        real_run_once = vr.Supervisor.run_once

        def run_once(sup, *args, **kwargs):
            result = real_run_once(sup, *args, **kwargs)
            self.gateway_up = False
            return result

        def broken_ensure():
            self.restarts += 1
            if self.restarts > 1:
                raise vr.Fail("the gateway did not answer at test (see proxy.log)")
            self.gateway_up = True
            return "test-token"

        with mock.patch.object(vr.Supervisor, "run_once", run_once), \
                mock.patch.object(vr, "ensure_proxy", broken_ensure):
            st = self.run_job(self.make_job())
        self.assertEqual(st["status"], "blocked", st)
        self.assertIn("the gateway did not answer", st["error"])
        self.assertEqual(len(self.calls()), 1)

    def test_offline_waits_then_retries_the_same_model(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"exit": 3}], openrouter__b=[{"text": "wrong\nSTATUS: done"}])
        online = threading.Event()
        self.tcp.side_effect = lambda *a, **k: online.is_set()
        d = self.make_job()
        self.start_thread(d)
        self.wait_for(d, "waiting", "network")
        self.assertTrue(any("no network, waiting" in n for n in vr.read_json(d / "state.json")["notes"]))
        self.scene(openrouter__a=[{"text": "ok\nSTATUS: done"}])
        online.set()
        self.wait_for(d, "status", "done")
        st = vr.read_json(d / "state.json")
        self.assertIn(st.get("waiting"), (None, ""))
        self.assertEqual(st["switches"], 0)
        self.assertEqual(st["slug"], "openrouter/a")
        self.assertEqual([c["model"] for c in self.calls()], ["openrouter/a", "openrouter/a"])

    def test_offline_past_the_hard_timeout_fails(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"exit": 3}], openrouter__b=[{"exit": 3}])
        self.tcp.return_value = False
        with mock.patch.object(vr, "HARD_TIMEOUT_SECONDS", 3):
            st = self.run_job(self.make_job())
        self.assertEqual(st["status"], "blocked", st)
        self.assertRegex(st["error"], r"^no network since \d\d:\d\d")
        self.assertEqual(st["switches"], 0)

    def test_cancel_works_while_waiting_for_the_network(self):
        self.models("openrouter/a")
        self.scene(openrouter__a=[{"exit": 3}])
        self.tcp.return_value = False
        d = self.make_job()
        t = self.start_thread(d)
        self.wait_for(d, "waiting", "network")
        (d / "cancel").touch()
        t.join(WAIT_SECONDS)
        self.assertFalse(t.is_alive())
        self.assertEqual(vr.read_json(d / "state.json")["status"], "cancelled")

    def test_healthy_infrastructure_still_switches_models(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"exit": 3}], openrouter__b=[{"text": "ok\nSTATUS: done"}])
        st = self.run_job(self.make_job())
        self.assertEqual(st["status"], "done")
        self.assertEqual(st["slug"], "openrouter/b")
        self.assertEqual(st["switches"], 1)
        self.assertEqual(self.restarts, 1)


class CooldownAndWindowTests(Base):
    """A transient failure cools a model down instead of dropping it; models too small for the session are skipped."""

    HEADROOM = 1000
    BIG_PROMPT = "x" * 12000  # about 3000 tokens at 4 bytes per token

    def setUp(self):
        super().setUp()
        patches = [
            mock.patch.object(vr, "MODEL_COOLDOWN_SECONDS", 0.5, create=True),
            mock.patch.object(vr, "REPLY_HEADROOM_TOKENS", self.HEADROOM, create=True),
            mock.patch.object(vr, "proxy_up", lambda token=None: True),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def flip_after(self, n, **scene):
        """After the n-th OpenCode run ends, replace the scenario."""
        real_run_once = vr.Supervisor.run_once
        count = []

        def run_once(sup, *args, **kwargs):
            result = real_run_once(sup, *args, **kwargs)
            count.append(1)
            if len(count) == n:
                self.scene(**scene)
            return result

        return mock.patch.object(vr.Supervisor, "run_once", run_once)

    def test_transient_failure_returns_to_the_preferred_model_after_cooldown(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"error": "overloaded", "status": 503}, {"sleep": 60}],
                   openrouter__b=[{"sleep": 1.0}, {"error": "timeout", "status": 504}, {"sleep": 60}])
        with self.flip_after(1, openrouter__a=[{"text": "ok\nSTATUS: done"}],
                             openrouter__b=[{"sleep": 1.0}, {"error": "timeout", "status": 504}, {"sleep": 60}]):
            st = self.run_job(self.make_job())
        self.assertEqual(st["status"], "done", st)
        self.assertEqual([c["model"] for c in self.calls()], ["openrouter/a", "openrouter/b", "openrouter/a"])
        self.assertEqual(st["slug"], "openrouter/a")
        self.assertEqual(st["switches"], 2)

    def test_all_models_cooling_waits_then_retries_instead_of_failing(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"error": "429 busy", "status": 429}, {"sleep": 60}],
                   openrouter__b=[{"error": "overloaded", "status": 503}, {"sleep": 60}])
        with mock.patch.object(vr, "MODEL_COOLDOWN_SECONDS", 4), \
                self.flip_after(2, openrouter__a=[{"text": "ok\nSTATUS: done"}]):
            d = self.make_job()
            self.start_thread(d)
            self.wait_for(d, "waiting", "models")
            st = vr.read_json(d / "state.json")
            self.assertTrue(any(re.search(r"all models cooling down, waiting until \d\d:\d\d", n)
                                for n in st["notes"]), st["notes"])
            self.wait_for(d, "status", "done")
        st = vr.read_json(d / "state.json")
        self.assertIn(st.get("waiting"), (None, ""))
        self.assertEqual([c["model"] for c in self.calls()], ["openrouter/a", "openrouter/b", "openrouter/a"])

    def test_cancel_works_while_models_cool_down(self):
        self.models("openrouter/a")
        self.scene(openrouter__a=[{"error": "overloaded", "status": 503}, {"sleep": 60}])
        d = self.make_job()
        with mock.patch.object(vr, "MODEL_COOLDOWN_SECONDS", 60):
            t = self.start_thread(d)
            self.wait_for(d, "waiting", "models")
            (d / "cancel").touch()
            t.join(WAIT_SECONDS)
        self.assertFalse(t.is_alive())
        self.assertEqual(vr.read_json(d / "state.json")["status"], "cancelled")

    def test_hard_timeout_ends_a_wait_for_cooling_models(self):
        self.models("openrouter/a")
        self.scene(openrouter__a=[{"error": "overloaded", "status": 503}, {"sleep": 60}])
        with mock.patch.object(vr, "MODEL_COOLDOWN_SECONDS", 60), mock.patch.object(vr, "HARD_TIMEOUT_SECONDS", 3):
            st = self.run_job(self.make_job())
        self.assertEqual(st["status"], "blocked", st)
        self.assertIn("hard timeout", st["error"])

    def test_context_overflow_removes_the_model_for_the_job(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"error": "input is ~126,021 tokens and exceeded the context window of "
                                            "every model tried", "name": "ContextOverflowError"}, {"sleep": 60}],
                   openrouter__b=[{"error": "overloaded", "status": 503}, {"sleep": 60}])
        with self.flip_after(2, openrouter__a=[{"text": "wrong\nSTATUS: done"}],
                             openrouter__b=[{"text": "ok\nSTATUS: done"}]):
            st = self.run_job(self.make_job())
        self.assertEqual(st["status"], "done", st)
        self.assertEqual([c["model"] for c in self.calls()], ["openrouter/a", "openrouter/b", "openrouter/b"])
        self.assertEqual(st["switches"], 1)

    def test_client_error_removes_the_model_for_the_job(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"error": "Prompt exceeds max length", "status": 400}, {"sleep": 60}],
                   openrouter__b=[{"error": "overloaded", "status": 503}, {"sleep": 60}])
        with self.flip_after(2, openrouter__a=[{"text": "wrong\nSTATUS: done"}],
                             openrouter__b=[{"text": "ok\nSTATUS: done"}]):
            st = self.run_job(self.make_job())
        self.assertEqual(st["status"], "done", st)
        self.assertEqual([c["model"] for c in self.calls()], ["openrouter/a", "openrouter/b", "openrouter/b"])

    def test_model_with_too_small_window_is_skipped_without_a_switch(self):
        self.models("openrouter/a", "openrouter/b", contexts={"openrouter/a": 2000, "openrouter/b": 100000})
        self.scene(openrouter__a=[{"text": "wrong\nSTATUS: done"}], openrouter__b=[{"text": "ok\nSTATUS: done"}])
        st = self.run_job(self.make_job(prompt=self.BIG_PROMPT))
        self.assertEqual(st["status"], "done", st)
        self.assertEqual([c["model"] for c in self.calls()], ["openrouter/b"])
        self.assertEqual(st["switches"], 0)

    def test_model_with_unknown_window_is_tried(self):
        self.models("openrouter/a", "openrouter/b")
        self.scene(openrouter__a=[{"text": "ok\nSTATUS: done"}], openrouter__b=[{"text": "wrong\nSTATUS: done"}])
        st = self.run_job(self.make_job(prompt=self.BIG_PROMPT))
        self.assertEqual([c["model"] for c in self.calls()], ["openrouter/a"])
        self.assertEqual(st["status"], "done", st)

    def test_nothing_fits_fails_with_a_clear_reason(self):
        self.models("openrouter/a", "openrouter/b", contexts={"openrouter/a": 2000, "openrouter/b": 3000})
        self.scene(openrouter__a=[{"text": "wrong\nSTATUS: done"}], openrouter__b=[{"text": "wrong\nSTATUS: done"}])
        st = self.run_job(self.make_job(prompt=self.BIG_PROMPT))
        self.assertEqual(st["status"], "blocked", st)
        self.assertRegex(st["error"], r"no model fits the session context \(~\d+ tokens\)")
        self.assertEqual(self.calls(), [])


class NoWindowTests(Base):
    """Every child process on Windows must carry CREATE_NO_WINDOW, detached launches included."""

    @unittest.skipUnless(os.name == "nt", "Windows only")
    def test_every_subprocess_call_has_create_no_window(self):
        seen = []
        real_popen, real_run = subprocess.Popen, subprocess.run

        class Recording(real_popen):
            def __init__(self, args, *a, **kw):
                seen.append(("Popen", args, kw.get("creationflags", 0)))
                super().__init__(args, *a, **kw)

        def run(args, *a, **kw):
            seen.append(("run", args, kw.get("creationflags", 0)))
            return real_run(args, *a, **kw)

        self.models("openrouter/a")
        with mock.patch.object(subprocess, "Popen", Recording), mock.patch.object(subprocess, "run", run):
            vr.kill_tree(99999999)
            vr.changed_files(str(self.work))
            proc = vr.spawn_detached([sys.executable, "-I", "-c", "pass"], self.tmp / "spawn.log")
            proc.wait(WAIT_SECONDS) if hasattr(proc, "wait") else None
            self.scene(openrouter__a=[{"text": "ok\nSTATUS: done"}])
            self.run_job(self.make_job())
        self.assertTrue(seen)
        missing = [(kind, args) for kind, args, flags in seen if not flags & vr.CREATE_NO_WINDOW]
        self.assertEqual(missing, [])


class JobObjectTests(unittest.TestCase):
    """A detached child must survive its launcher even inside a Job that kills on close and forbids breakaway."""

    @unittest.skipUnless(os.name == "nt", "Windows only")
    def test_detached_child_outlives_a_non_breakaway_job(self):
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
        kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]

        class BasicLimits(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                        ("SchedulingClass", wintypes.DWORD)]

        class IoCounters(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ("r", "w", "o", "rb", "wb", "ob")]

        class ExtendedLimits(ctypes.Structure):
            _fields_ = [("Basic", BasicLimits), ("Io", IoCounters), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        kill_on_close = 0x2000
        extended_info_class = 9
        tmp = Path(tempfile.mkdtemp(prefix="volunteer-test-")).resolve()
        self.addCleanup(shutil.rmtree, tmp, True)
        go, pid_file = tmp / "go", tmp / "child.pid"
        job = kernel32.CreateJobObjectW(None, None)
        self.assertTrue(job)
        info = ExtendedLimits()
        info.Basic.LimitFlags = kill_on_close
        self.assertTrue(kernel32.SetInformationJobObject(job, extended_info_class, ctypes.byref(info),
                                                         ctypes.sizeof(info)))
        launcher = subprocess.Popen([sys.executable, "-I", str(HERE / "job_launcher.py"), str(go), str(pid_file)],
                                    creationflags=vr.CREATE_NO_WINDOW)
        child_pid = []
        closed = []

        def cleanup():
            if not closed:
                kernel32.CloseHandle(job)
            launcher.kill()
            launcher.wait()
            if child_pid:
                vr.kill_tree(child_pid[0])

        self.addCleanup(cleanup)
        self.assertTrue(kernel32.AssignProcessToJobObject(job, int(launcher._handle)), "cannot put launcher in job")
        go.touch()
        deadline = time.time() + WAIT_SECONDS
        while not pid_file.exists() and time.time() < deadline:
            time.sleep(0.1)
        self.assertTrue(pid_file.exists(), "launcher never started the detached child")
        time.sleep(0.3)
        child_pid.append(int(pid_file.read_text()))
        self.assertTrue(vr.pid_alive(child_pid[0]))
        kernel32.CloseHandle(job)
        closed.append(1)
        launcher.wait(WAIT_SECONDS)
        time.sleep(1)
        self.assertTrue(vr.pid_alive(child_pid[0]), "the detached child died with the job")


if __name__ == "__main__":
    unittest.main()
