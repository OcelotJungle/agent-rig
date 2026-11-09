"""Tests for the reflection hook: the ANALYSIS FILE line of the review input, and a live probe of the reviewer.

The unit tests make no model call. The probe calls the real reviewer (a few cents); it runs only with
REFLECT_LIVE_PROBE=1:
    REFLECT_LIVE_PROBE=1 python -I -m unittest discover -v -s features/reflection/hooks/tests -p test_reflect.py -k Probe
"""
import importlib.util
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[1] / "reflect.py"
SPEC = importlib.util.spec_from_file_location("reflect", SCRIPT)
REFLECT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REFLECT)

VALID_ANALYSIS = "## Unknowns\n- the size of the loader\n\n## Class\nno defect: a config loader refactor\n"
# The tests are not allowed to hold Cyrillic, so the Russian turn is written with escapes (an estimate of about 40 minutes).
RUSSIAN_ESTIMATE = "\u0420\u0435\u0444\u0430\u043a\u0442\u043e\u0440\u0438\u043d\u0433 \u0437\u0430\u0439\u043c\u0451\u0442 \u043e\u043a\u043e\u043b\u043e 40 \u043c\u0438\u043d\u0443\u0442."
STAMP = "2026-01-01T10:00:0{}.000Z"
ENV_KEYS = ("CLAUDE_PROJECT_DIR", REFLECT.CHILD_ENV)


def text_entry(kind, second, text):
    content = text if kind == "user" else [{"type": "text", "text": text}]
    return {"type": kind, "timestamp": STAMP.format(second), "message": {"role": kind, "content": content}}


def tool_entries(second):
    call = {"type": "assistant", "timestamp": STAMP.format(second), "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "bun test tests/config"}}]}}
    result = {"type": "user", "timestamp": STAMP.format(second + 1), "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": "12 pass, 0 fail, ran in 3.6 s"}]}}
    return [call, result]


class ProjectCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.dir = Path(directory.name)
        self.project = self.dir / "project"
        self.project.mkdir()
        self.state = self.dir / "state"
        for name, value in (("STATE_DIR", self.state), ("LOG_FILE", self.state / "log.jsonl"), ("TURNS_DIR", self.state / "turns")):
            patcher = mock.patch.object(REFLECT, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ)
        env.start()
        self.addCleanup(env.stop)
        for key in ENV_KEYS:
            os.environ.pop(key, None)
        self.rig_state = self.dir / "rig-state.json"
        patcher = mock.patch.object(REFLECT, "RIG_STATE", self.rig_state)
        patcher.start()
        self.addCleanup(patcher.stop)

    def set_feature(self, enabled):
        self.rig_state.write_text(json.dumps({"features": {"analysis-gate": enabled}}), encoding="utf-8")

    def write_analysis(self, content=VALID_ANALYSIS):
        path = self.project / ".tmp" / "analysis.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def payload(self, user, final):
        transcript = self.dir / "session.jsonl"
        entries = [text_entry("user", 0, user), *tool_entries(1), text_entry("assistant", 3, final)]
        transcript.write_text("".join(json.dumps(e) + "\n" for e in entries), encoding="utf-8")
        return {"transcript_path": str(transcript), "session_id": "probe", "cwd": str(self.project), "last_assistant_message": final}

    def review_input(self, payload):
        with mock.patch.dict(os.environ, {"REFLECT_DRY": "1"}):
            REFLECT.review(payload)
        return (REFLECT.TURNS_DIR / "probe.input.txt").read_text(encoding="utf-8")


class AnalysisLineTests(ProjectCase):
    def test_line_says_ok_for_a_valid_file_when_the_feature_is_on(self):
        self.set_feature(True)
        self.write_analysis()
        text = self.review_input(self.payload("How long will the refactor take?", "It will take about 40 minutes."))
        self.assertIn("ANALYSIS FILE: ok\n", text)

    def test_line_gives_the_reason_for_a_missing_file_when_the_feature_is_on(self):
        self.set_feature(True)
        text = self.review_input(self.payload("How long will the refactor take?", "It will take about 40 minutes."))
        line = next(l for l in text.splitlines() if l.startswith("ANALYSIS FILE:"))
        self.assertIn("missing", line)
        self.assertNotEqual(line, "ANALYSIS FILE: ok")

    def test_no_line_when_the_feature_is_off(self):
        self.set_feature(False)
        text = self.review_input(self.payload("How long will the refactor take?", "It will take about 40 minutes."))
        self.assertNotIn("ANALYSIS FILE", text)

    def test_no_line_when_rig_state_is_missing(self):
        text = self.review_input(self.payload("How long will the refactor take?", "It will take about 40 minutes."))
        self.assertNotIn("ANALYSIS FILE", text)


ESTIMATE_KIND = 6  # check 6 of reflect_prompt.md: an estimate without the analysis file


def kinds(answer):
    return [p["kind"] for p in answer["problems"]] if answer else []


@unittest.skipUnless(os.environ.get("REFLECT_LIVE_PROBE") == "1", "set REFLECT_LIVE_PROBE=1 to run the real reviewer probe")
class ReflectLiveProbe(ProjectCase):
    """Real reviewer, three invented turns; the input is built by reflect.review like a Stop hook run."""

    # The reviewer reads the user's real rules, so other checks may flag an invented turn (an English reply
    # breaks the Russian rule); the probe judges only the estimate check.
    def verdict(self, user, final):
        _, answer = REFLECT.review(self.payload(user, final))
        return answer

    def test_estimate_without_a_file_is_flagged(self):
        self.set_feature(True)
        answer = self.verdict("Please look at the config loader and tell me how long the refactor would take.",
                              f"I looked at the loader. Refactoring it will take about 40 minutes. {RUSSIAN_ESTIMATE}")
        self.assertIn(ESTIMATE_KIND, kinds(answer))

    def test_measured_duration_without_a_file_is_not_flagged(self):
        self.set_feature(True)
        answer = self.verdict("Run the config tests and report.", "The config tests passed: 12 pass, 0 fail. They ran in 3.6 s.")
        self.assertNotIn(ESTIMATE_KIND, kinds(answer))

    def test_estimate_with_a_valid_file_is_not_flagged(self):
        self.set_feature(True)
        self.write_analysis()
        answer = self.verdict("Please look at the config loader and tell me how long the refactor would take.",
                              "I looked at the loader. Refactoring it will take about 40 minutes.")
        self.assertNotIn(ESTIMATE_KIND, kinds(answer))


if __name__ == "__main__":
    unittest.main()
