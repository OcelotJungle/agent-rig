"""Tests for volunteer-failures.py and that both volunteer scripts use its rule."""
import importlib.util
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, TOOLS / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


failures = load("volunteer_failures", "volunteer-failures.py")
run = load("volunteer_run_for_failures", "volunteer-run.py")
models = load("volunteer_models_for_failures", "volunteer-models.py")

PERMANENT = (400, 401, 403, 404, 410, 413)
TRANSIENT = (0, 408, 429, 500, 502, 503, 504)


class PermanentStatus(unittest.TestCase):
    def test_permanent(self):
        for code in PERMANENT:
            self.assertTrue(failures.is_permanent_status(code), code)

    def test_transient_and_no_answer(self):
        for code in TRANSIENT:
            self.assertFalse(failures.is_permanent_status(code), code)


class BothScriptsShareTheRule(unittest.TestCase):
    def test_run_classifies_by_the_shared_rule(self):
        self.assertTrue(run.is_permanent_failure("HTTP 404"))
        self.assertTrue(run.is_permanent_failure("HTTP 410"))
        self.assertFalse(run.is_permanent_failure("HTTP 502"))
        self.assertFalse(run.is_permanent_failure("HTTP 429"))

    def test_models_classifies_by_the_shared_rule(self):
        for code in PERMANENT:
            self.assertFalse(models.is_transient_failure(code), code)
        for code in TRANSIENT:
            self.assertTrue(models.is_transient_failure(code), code)
        self.assertFalse(models.is_transient_failure(200))

    def test_the_two_scripts_agree_on_every_status(self):
        for code in list(PERMANENT) + list(TRANSIENT):
            if code:
                self.assertEqual(run.is_permanent_failure("HTTP %d" % code), not models.is_transient_failure(code), code)


if __name__ == "__main__":
    unittest.main()
