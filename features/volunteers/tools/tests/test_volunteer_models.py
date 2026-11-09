"""Tests for volunteer-models.py: fake proxy and listings on a local http.server, no network."""
import importlib.util
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parent.parent / "volunteer-models.py"
spec = importlib.util.spec_from_file_location("volunteer_models", SCRIPT)
vm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vm)

TOKEN = "test-token"
FAV1 = "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"
FAV2 = "openrouter/cohere/north-mini-code:free"


def or_entry(mid, prompt="0", completion="0", params=("tools", "temperature"), ctx=128000):
    return {
        "id": mid,
        "context_length": ctx,
        "pricing": {"prompt": prompt, "completion": completion},
        "supported_parameters": list(params),
    }


OR_LISTING = {
    "data": [
        or_entry("nvidia/nemotron-3-ultra-550b-a55b:free"),
        or_entry("cohere/north-mini-code:free"),
        or_entry("meta/fast-model:free"),
        or_entry("meta/slow-model:free"),
        or_entry("meta/priced:free", prompt="0.000001"),
        or_entry("meta/priced-out:free", completion="0.000002"),
        or_entry("meta/no-tools:free", params=("temperature",)),
        or_entry("meta/small-ctx:free", ctx=32000),
        or_entry("meta/not-free-suffix", prompt="0", completion="0"),
        or_entry("openrouter/free"),
    ]
}


def rq_entry(mid, inp=0, out=0, caching=None, tools=True, ctx=131072, api="chat"):
    return {
        "id": mid,
        "api": api,
        "input_price": inp,
        "output_price": out,
        "caching_price": caching,
        "pricing": [{"input_price": inp, "output_price": out}],
        "supports_tool_calling": tools,
        "context_window": ctx,
    }


RQ_LISTING = {
    "data": [
        rq_entry("nvidia/free-one"),
        rq_entry("nvidia/priced", inp=1e-7),
        rq_entry("nvidia/priced-caching", caching=1e-6),
        rq_entry("nvidia/no-tools", tools=False),
        rq_entry("nvidia/small", ctx=32768),
        rq_entry("nvidia/embed", api="embeddings"),
    ]
}


class FakeServer:
    """Serves /v1/models, /v1/chat/completions (behaviour by model) and the public listings."""

    def __init__(self, proxy_ids, behaviours):
        self.proxy_ids = proxy_ids
        self.behaviours = behaviours
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def send(self, code, obj):
                raw = json.dumps(obj).encode("utf-8")
                try:
                    self.send_response(code)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(raw)))
                    self.end_headers()
                    self.wfile.write(raw)
                except OSError:
                    pass

            def do_GET(self):
                if self.path == "/v1/models":
                    if self.headers.get("Authorization") != "Bearer " + TOKEN:
                        return self.send(401, {})
                    return self.send(200, {"data": [{"id": i} for i in outer.proxy_ids]})
                if self.path == "/or":
                    return self.send(200, OR_LISTING)
                if self.path == "/rq":
                    return self.send(200, RQ_LISTING)
                self.send(404, {})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append(body)
                kind = outer.behaviours.get(body["model"], "ok")
                if isinstance(kind, tuple):
                    kind, delay = kind
                    time.sleep(delay)
                if kind.isdigit():
                    return self.send(int(kind), {"error": "status " + kind})
                msg = {"role": "assistant", "content": "I cannot do that"}
                if kind == "ok":
                    msg["tool_calls"] = [tool_call("get_weather", '{"city": "Paris"}')]
                elif kind == "bad-args":
                    msg["tool_calls"] = [tool_call("get_weather", "{city: Paris")]
                elif kind == "wrong-tool":
                    msg["tool_calls"] = [tool_call("other", "{}")]
                elif kind == "garbage":
                    return self.send(200, {"unexpected": True})
                self.send(200, {"choices": [{"message": msg}]})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


def tool_call(name, arguments):
    return {"id": "c1", "type": "function", "function": {"name": name, "arguments": arguments}}


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="vm-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cache = Path(self.tmp) / "models.json"
        self.token_file = Path(self.tmp) / "token.txt"
        self.token_file.write_text(TOKEN + "\n", encoding="utf-8")

    def args(self, server, **kw):
        base = dict(
            proxy_url=server.url,
            token_file=str(self.token_file),
            cache=str(self.cache),
            max_requests=vm.MAX_REQUESTS,
            timeout=5,
            openrouter_url=server.url + "/or",
            requesty_url=server.url + "/rq",
        )
        base.update(kw)
        return SimpleNamespace(**base)

    def run_refresh(self, server, **kw):
        code = vm.refresh(self.args(server, **kw))
        data = json.loads(self.cache.read_text(encoding="utf-8")) if self.cache.exists() else None
        return code, data


class ListingFilters(unittest.TestCase):
    def test_openrouter_filters(self):
        ids = vm.openrouter_free_ids(OR_LISTING)
        self.assertEqual(
            ids,
            {
                FAV1,
                FAV2,
                "openrouter/meta/fast-model:free",
                "openrouter/meta/slow-model:free",
            },
        )

    def test_openrouter_router_dropped(self):
        self.assertNotIn("openrouter/openrouter/free", vm.openrouter_free_ids(OR_LISTING))

    def test_requesty_only_verified_zero(self):
        self.assertEqual(vm.requesty_free_ids(RQ_LISTING), {"requesty/nvidia/free-one"})

    def test_requesty_missing_price_is_not_free(self):
        listing = {"data": [{"id": "x/y", "api": "chat", "supports_tool_calling": True, "context_window": 99999}]}
        self.assertEqual(vm.requesty_free_ids(listing), set())

    def test_provider_filtering(self):
        proxy_ids = [
            "auto",
            "agent",
            FAV1,
            "openrouter/meta/priced:free",
            "openrouter/openrouter/free",
            "groq/openai/gpt-oss-120b",
            "zhipu/glm-4.7-flash",
            "requesty/nvidia/free-one",
            "requesty/nvidia/priced",
            "pollinations/openai",
            "ovh/gpt-oss-120b",
            "kilo/x:free",
            "opencode/y",
            "llm7/z",
            "gemini/gemini-2.5-flash",
        ]
        got = vm.select_candidates(
            proxy_ids, vm.openrouter_free_ids(OR_LISTING), vm.requesty_free_ids(RQ_LISTING)
        )
        self.assertEqual(
            got,
            [FAV1, "groq/openai/gpt-oss-120b", "zhipu/glm-4.7-flash", "requesty/nvidia/free-one"],
        )

    def test_unavailable_listing_drops_provider(self):
        got = vm.select_candidates([FAV1, "groq/a", "requesty/b"], None, None)
        self.assertEqual(got, ["groq/a"])

    def test_test_order_favorites_first(self):
        cands = ["groq/a", "openrouter/m:free", FAV2, "zhipu/z", FAV1]
        self.assertEqual(vm.test_order(cands)[:2], [FAV1, FAV2])


class Ordering(unittest.TestCase):
    def test_order_and_agent(self):
        passed = [
            ("groq/openai/gpt-oss-120b", 0.5),
            ("openrouter/meta/slow-model:free", 9.0),
            (FAV2, 8.0),
            ("openrouter/meta/fast-model:free", 1.0),
            ("zhipu/glm-4.7-flash", 2.0),
            (FAV1, 7.0),
            ("groq/openai/gpt-oss-20b", 0.2),
        ]
        out = vm.order_models(passed)
        self.assertEqual(
            [m["id"] for m in out],
            [
                FAV1,
                FAV2,
                "openrouter/meta/fast-model:free",
                "zhipu/glm-4.7-flash",
                "openrouter/meta/slow-model:free",
                "groq/openai/gpt-oss-20b",
                "groq/openai/gpt-oss-120b",
            ],
        )
        agents = {m["id"]: m["agent"] for m in out}
        self.assertEqual(agents["groq/openai/gpt-oss-120b"], "minimal")
        self.assertEqual(agents[FAV1], "full")
        self.assertEqual(agents["zhipu/glm-4.7-flash"], "full")
        self.assertEqual(out[0]["latency_s"], 7.0)

    def test_missing_favorite_skipped(self):
        out = vm.order_models([("openrouter/a:free", 1.0)])
        self.assertEqual([m["id"] for m in out], ["openrouter/a:free"])


class SmokeClassification(unittest.TestCase):
    def check(self, behaviour, ok, reason, timeout=5, status=None):
        with FakeServer([], {"m/x": behaviour}) as srv:
            got_ok, latency, got_reason, got_status = vm.smoke_test(srv.url, TOKEN, "m/x", timeout)
            self.assertEqual((got_ok, got_reason), (ok, reason))
            if status is not None:
                self.assertEqual(got_status, status)
            self.assertGreaterEqual(latency, 0)
            return srv

    def test_pass_and_request_shape(self):
        srv = self.check("ok", True, "")
        body = srv.requests[0]
        self.assertEqual(body["model"], "m/x")
        self.assertEqual(body["tools"][0]["function"]["name"], "get_weather")

    def test_no_tool_call(self):
        self.check("text", False, "no tool call")

    def test_bad_arguments(self):
        self.check("bad-args", False, "invalid tool arguments")

    def test_wrong_tool(self):
        self.check("wrong-tool", False, "wrong tool call")

    def test_429(self):
        self.check("429", False, "http 429", status=429)

    def test_413(self):
        self.check("413", False, "http 413", status=413)

    def test_502_exposes_status(self):
        self.check("502", False, "http 502", status=502)

    def test_malformed(self):
        self.check("garbage", False, "malformed response", status=200)

    def test_content_failure_has_status_200(self):
        self.check("text", False, "no tool call", status=200)

    def test_timeout(self):
        self.check(("ok", 1.5), False, "timeout", timeout=0.3, status=0)


class UnverifiedOrdering(unittest.TestCase):
    def test_kept_favorite_keeps_its_place(self):
        out = vm.order_models([("openrouter/a:free", 1.0)], {FAV2: ("http 502", 99.0), FAV1: ("timeout", None)})
        self.assertEqual([m["id"] for m in out], [FAV1, FAV2, "openrouter/a:free"])
        self.assertEqual(out[0]["unverified"], "timeout")
        self.assertNotIn("latency_s", out[0])

    def test_unverified_goes_after_measured_of_its_group(self):
        passed = [("openrouter/a:free", 1.0), ("openrouter/c:free", 5.0)]
        out = vm.order_models(passed, {"openrouter/b:free": ("http 429", 3.0)})
        self.assertEqual([m["id"] for m in out], ["openrouter/a:free", "openrouter/c:free", "openrouter/b:free"])
        self.assertEqual(out[2]["latency_s"], 3.0)
        self.assertEqual(out[2]["unverified"], "http 429")
        self.assertNotIn("unverified", out[0])

    def test_measured_first_even_when_unverified_had_lower_previous_latency(self):
        passed = [("openrouter/c:free", 5.0), ("groq/g1", 5.0)]
        unverified = {"openrouter/b:free": ("http 502", 1.0), "groq/g2": ("http 502", 1.0)}
        out = vm.order_models(passed, unverified)
        self.assertEqual([m["id"] for m in out], ["openrouter/c:free", "openrouter/b:free", "groq/g1", "groq/g2"])

    def test_unverified_ordered_among_themselves_by_previous_latency_none_last(self):
        unverified = {
            "openrouter/n:free": ("timeout", None),
            "openrouter/z:free": ("timeout", 4.0),
            "openrouter/y:free": ("timeout", 2.0),
            "openrouter/x:free": ("timeout", 2.0),
        }
        out = vm.order_models([], unverified)
        self.assertEqual([m["id"] for m in out],
                         ["openrouter/x:free", "openrouter/y:free", "openrouter/z:free", "openrouter/n:free"])

    def test_without_latency_goes_last_in_its_group(self):
        passed = [("openrouter/a:free", 1.0), ("groq/g1", 0.5)]
        out = vm.order_models(passed, {"openrouter/b:free": ("timeout", None), "groq/g2": ("timeout", None)})
        self.assertEqual([m["id"] for m in out], ["openrouter/a:free", "openrouter/b:free", "groq/g1", "groq/g2"])
        self.assertEqual(out[3]["agent"], "minimal")


class RefreshFlow(TempDirCase):
    def test_full_refresh(self):
        proxy_ids = [
            "auto",
            FAV1,
            FAV2,
            "openrouter/meta/fast-model:free",
            "openrouter/meta/slow-model:free",
            "openrouter/meta/priced:free",
            "groq/openai/gpt-oss-120b",
            "zhipu/glm-4.7-flash",
            "requesty/nvidia/free-one",
            "gemini/gemini-2.5-flash",
            "llm7/z",
        ]
        behaviours = {
            "zhipu/glm-4.7-flash": "429",
            "openrouter/meta/slow-model:free": "text",
            "requesty/nvidia/free-one": "ok",
        }
        with FakeServer(proxy_ids, behaviours) as srv:
            code, data = self.run_refresh(srv)
            asked = {r["model"] for r in srv.requests}
        self.assertEqual(code, 0)
        ids = [m["id"] for m in data["models"]]
        self.assertEqual(ids[:2], [FAV1, FAV2])
        self.assertEqual(ids[-1], "groq/openai/gpt-oss-120b")
        self.assertEqual(set(ids), {FAV1, FAV2, "openrouter/meta/fast-model:free", "requesty/nvidia/free-one",
                                    "groq/openai/gpt-oss-120b", "zhipu/glm-4.7-flash"})
        rejected = {r["id"]: r["reason"] for r in data["rejected"]}
        self.assertNotIn("zhipu/glm-4.7-flash", rejected)
        self.assertEqual(
            next(m for m in data["models"] if m["id"] == "zhipu/glm-4.7-flash")["unverified"], "http 429")
        self.assertEqual(rejected["openrouter/meta/slow-model:free"], "no tool call")
        self.assertNotIn("openrouter/meta/priced:free", asked)
        self.assertNotIn("gemini/gemini-2.5-flash", asked)
        self.assertNotIn("llm7/z", asked)
        self.assertRegex(data["checked_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        agents = {m["id"]: m["agent"] for m in data["models"]}
        self.assertEqual(agents["groq/openai/gpt-oss-120b"], "minimal")
        self.assertEqual(agents[FAV1], "full")

    def refresh_with(self, behaviours, previous=None, **kw):
        proxy_ids = [FAV1, "openrouter/meta/fast-model:free", "openrouter/meta/slow-model:free"]
        if previous is not None:
            self.cache.write_text(json.dumps({"models": previous}), encoding="utf-8")
        with FakeServer(proxy_ids, behaviours) as srv:
            code, data = self.run_refresh(srv, **kw)
        return code, data, {m["id"]: m for m in data["models"]}, {r["id"]: r["reason"] for r in data["rejected"]}

    def test_transient_failures_stay_unverified(self):
        for kind, reason, extra in (("502", "http 502", {}), ("429", "http 429", {}), ("408", "http 408", {}),
                                    (("ok", 1.5), "timeout", {"timeout": 0.3})):
            with self.subTest(reason=reason):
                _, data, models, rejected = self.refresh_with({"openrouter/meta/slow-model:free": kind}, **extra)
                self.assertEqual(models["openrouter/meta/slow-model:free"]["unverified"], reason)
                self.assertNotIn("openrouter/meta/slow-model:free", rejected)

    def test_permanent_and_content_failures_are_rejected(self):
        for kind, reason in (("404", "http 404"), ("410", "http 410"), ("400", "http 400"), ("text", "no tool call")):
            with self.subTest(reason=reason):
                _, data, models, rejected = self.refresh_with({"openrouter/meta/slow-model:free": kind})
                self.assertNotIn("openrouter/meta/slow-model:free", models)
                self.assertEqual(rejected["openrouter/meta/slow-model:free"], reason)

    def test_all_models_transient_still_leaves_the_cache_populated(self):
        code, data, models, rejected = self.refresh_with(
            {m: "502" for m in (FAV1, "openrouter/meta/fast-model:free", "openrouter/meta/slow-model:free")})
        self.assertEqual(len(models), 3)
        self.assertEqual(rejected, {})
        self.assertEqual(code, 0)

    def test_kept_models_use_previous_cache_latency_and_favorite_place(self):
        previous = [{"id": "openrouter/meta/slow-model:free", "agent": "full", "latency_s": 0.05},
                    {"id": FAV1, "agent": "full", "latency_s": 9.0}]
        _, data, models, _ = self.refresh_with(
            {FAV1: "502", "openrouter/meta/slow-model:free": "502", "openrouter/meta/fast-model:free": ("ok", 0.2)},
            previous=previous)
        ids = [m["id"] for m in data["models"]]
        self.assertEqual(ids[0], FAV1)
        self.assertEqual(models["openrouter/meta/slow-model:free"]["latency_s"], 0.05)
        self.assertEqual(ids[1:], ["openrouter/meta/fast-model:free", "openrouter/meta/slow-model:free"])

    def test_kept_model_without_previous_latency_goes_last(self):
        _, data, models, _ = self.refresh_with(
            {"openrouter/meta/slow-model:free": "502", "openrouter/meta/fast-model:free": ("ok", 0.2)})
        ids = [m["id"] for m in data["models"]]
        self.assertEqual(ids[-1], "openrouter/meta/slow-model:free")
        self.assertNotIn("latency_s", models["openrouter/meta/slow-model:free"])

    def test_request_cap(self):
        proxy_ids = [FAV1, FAV2, "openrouter/meta/fast-model:free", "openrouter/meta/slow-model:free"]
        with FakeServer(proxy_ids, {}) as srv:
            code, data = self.run_refresh(srv, max_requests=2)
            self.assertEqual(len(srv.requests), 2)
        self.assertEqual(code, 0)
        self.assertEqual([m["id"] for m in data["models"]], [FAV1, FAV2])
        reasons = {r["id"]: r["reason"] for r in data["rejected"]}
        self.assertIn("not checked", reasons["openrouter/meta/fast-model:free"])

    def test_no_working_model(self):
        with FakeServer([FAV1], {FAV1: "404"}) as srv:
            code, data = self.run_refresh(srv)
        self.assertEqual(code, vm.EXIT_NO_MODELS)
        self.assertEqual(data["models"], [])

    def test_proxy_down(self):
        with FakeServer([], {}) as srv:
            url = srv.url
        code = vm.refresh(self.args(SimpleNamespace(url=url)))
        self.assertEqual(code, vm.EXIT_PROXY)
        self.assertFalse(self.cache.exists())

    def test_listing_unavailable_is_reported(self):
        with FakeServer([FAV1, "groq/a"], {}) as srv:
            code, data = self.run_refresh(srv, openrouter_url=srv.url + "/missing")
        self.assertEqual([m["id"] for m in data["models"]], ["groq/a"])
        self.assertTrue(any(r["id"] == "openrouter/*" for r in data["rejected"]))


class AtomicWrite(TempDirCase):
    def test_write_replaces_and_leaves_no_temp(self):
        self.cache.write_text("old", encoding="utf-8")
        vm.write_cache(self.cache, {"a": 1})
        self.assertEqual(json.loads(self.cache.read_text(encoding="utf-8")), {"a": 1})
        self.assertEqual(os.listdir(self.tmp).count("models.json"), 1)
        self.assertEqual([f for f in os.listdir(self.tmp) if f.endswith(".tmp")], [])

    def test_failed_write_keeps_old_file(self):
        vm.write_cache(self.cache, {"a": 1})
        with self.assertRaises(TypeError):
            vm.write_cache(self.cache, {"bad": object()})
        self.assertEqual(json.loads(self.cache.read_text(encoding="utf-8")), {"a": 1})
        self.assertEqual([f for f in os.listdir(self.tmp) if f.endswith(".tmp")], [])


class Lock(TempDirCase):
    def test_second_acquire_fails_until_release(self):
        lock = Path(self.tmp) / "models.json.lock"
        self.assertTrue(vm.acquire_lock(lock))
        self.assertFalse(vm.acquire_lock(lock))
        vm.release_lock(lock)
        self.assertTrue(vm.acquire_lock(lock))
        vm.release_lock(lock)

    def test_stale_lock_is_taken_over(self):
        lock = Path(self.tmp) / "models.json.lock"
        lock.write_text("123", encoding="utf-8")
        old = time.time() - vm.LOCK_STALE_S - 10
        os.utime(lock, (old, old))
        self.assertTrue(vm.acquire_lock(lock))
        vm.release_lock(lock)

    def test_refresh_refuses_while_locked_and_releases_after(self):
        lock = Path(self.tmp) / "models.json.lock"
        with FakeServer([FAV1], {}) as srv:
            lock.write_text("1", encoding="utf-8")
            self.assertEqual(vm.refresh(self.args(srv)), vm.EXIT_LOCKED)
            self.assertFalse(self.cache.exists())
            lock.unlink()
            self.assertEqual(vm.refresh(self.args(srv)), 0)
        self.assertFalse(lock.exists())


def prov(pid, *models):
    return {"id": pid, "models": [{"name": n, "rpd": rpd, "used_today": u} for n, rpd, u in models]}


STATUS = {
    "providers": [
        prov("openrouter", ("a:free", 1000, 20), ("b:free", 1000, 9)),
        prov("requesty", ("x", 0, 3), ("y", 0, 1)),
        prov("groq", ("g1", 1000, 190), ("g2", 500, 4), ("not-cached", 1000, 77)),
        prov("zhipu", ("z", 1000, 4)),
        prov("gemini", ("gem", 250, 50)),
        prov("ovh", ("o", 0, 9)),
    ]
}


class StatusServer:
    def __init__(self, payload, code=200):
        outer = self
        self.seen_auth = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                outer.seen_auth.append(self.headers.get("Authorization"))
                raw = json.dumps(payload).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]

    def __enter__(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


class Limits(TempDirCase):
    SECRET = "s3cret-limits-token"

    def setUp(self):
        super().setUp()
        self.token_file.write_text(self.SECRET + "\n", encoding="utf-8")
        self.models = Path(self.tmp) / "m.json"
        self.models.write_text(
            json.dumps({"models": [{"id": "openrouter/a:free"}, {"id": "groq/g1"}, {"id": "groq/g2"}]}),
            encoding="utf-8",
        )
        self.quota = Path(self.tmp) / "quota.json"
        self.now = vm.datetime(2026, 10, 27, 18, 50, tzinfo=vm.timezone.utc)

    def ns(self, url="http://127.0.0.1:1"):
        return SimpleNamespace(
            proxy_url=url,
            token_file=str(self.token_file),
            quota_file=str(self.quota),
            models_file=str(self.models),
            json=False,
        )

    def run_main(self, url, *extra):
        import contextlib
        import io

        buf = io.StringIO()
        args = ["limits", *extra, "--proxy-url", url, "--token-file", str(self.token_file),
                "--quota-file", str(self.quota), "--models-file", str(self.models)]
        with contextlib.redirect_stdout(buf):
            code = vm.main(args)
        return code, buf.getvalue()

    def test_proxy_aggregation(self):
        with StatusServer(STATUS) as srv:
            r = vm.compute_limits(self.ns(srv.url), self.now)
            self.assertEqual(srv.seen_auth, ["Bearer " + self.SECRET])
        self.assertEqual(r["source"], "proxy")
        p = r["providers"]
        self.assertEqual(p["openrouter"], {"used": 29, "cap": 1000})
        self.assertEqual(p["requesty"], {"used": 4, "cap": 200})
        self.assertEqual(p["groq"], {"used": 194, "cap": 1500})
        self.assertEqual(p["zhipu"], {"used": 4, "cap": None})
        self.assertNotIn("gemini", p)
        self.assertNotIn("ovh", p)
        self.assertEqual((r["used"], r["cap"]), (227, 2700))
        self.assertEqual(r["day_percent"], 8)
        self.assertEqual(r["reset_in_s"], 5 * 3600 + 10 * 60)
        self.assertIsNone(r["error"])

    def test_groq_override(self):
        old = dict(vm.GROQ_RPD_OVERRIDE)
        vm.GROQ_RPD_OVERRIDE["g1"] = 100
        self.addCleanup(lambda: (vm.GROQ_RPD_OVERRIDE.clear(), vm.GROQ_RPD_OVERRIDE.update(old)))
        with StatusServer(STATUS) as srv:
            r = vm.compute_limits(self.ns(srv.url), self.now)
        self.assertEqual(r["providers"]["groq"]["cap"], 600)

    def test_quota_fallback(self):
        self.quota.write_text(
            json.dumps({"2026-10-26": {"groq::g1": 999}, "2026-10-27": {
                "openrouter::a:free": 10, "openrouter::b:free": 5, "requesty::x": 2,
                "groq::g1": 7, "groq::other": 50, "zhipu::z": 1, "gemini::gem": 9, "ovh::o": 4}}),
            encoding="utf-8",
        )
        r = vm.compute_limits(self.ns(), self.now)
        self.assertEqual(r["source"], "quota-file")
        self.assertEqual(r["providers"]["openrouter"]["used"], 15)
        self.assertEqual(r["providers"]["requesty"]["used"], 2)
        self.assertEqual(r["providers"]["groq"], {"used": 7, "cap": 1000})
        self.assertEqual(r["providers"]["zhipu"]["used"], 1)

    def test_proxy_error_status_falls_back(self):
        self.quota.write_text(json.dumps({"2026-10-27": {"requesty::x": 1}}), encoding="utf-8")
        with StatusServer({}, code=401) as srv:
            r = vm.compute_limits(self.ns(srv.url), self.now)
        self.assertEqual(r["source"], "quota-file")

    def test_no_data(self):
        r = vm.compute_limits(self.ns(), self.now)
        self.assertEqual(r["source"], "none")
        self.assertIsNone(r["day_percent"])
        self.assertIn("proxy", r["error"])
        self.assertIn("quota", r["error"])
        self.assertIn("no data", vm.format_limits(r))

    def test_json_shape_and_exit_code(self):
        with StatusServer(STATUS) as srv:
            code, out = self.run_main(srv.url, "--json")
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertEqual(
            set(data),
            {"checked_at", "source", "day_percent", "used", "cap", "reset_in_s", "providers", "error"},
        )
        self.assertNotIn(self.SECRET, out)

    def test_human_output(self):
        with StatusServer(STATUS) as srv:
            r = vm.compute_limits(self.ns(srv.url), self.now)
        text = vm.format_limits(r)
        lines = text.split("\n")
        self.assertEqual(lines[0], "**Volunteer limits** (live data)")
        self.assertEqual(lines[1], "Day: 8% (resets in 5 h 10 min)")
        self.assertEqual(lines[2], "OpenRouter 29/1000 · Requesty 4/200 · Groq 194/1500 · Z.ai 4 req.")
        self.assertNotIn(self.SECRET, text)

    def test_no_data_exit_zero_and_no_token(self):
        code, out = self.run_main("http://127.0.0.1:1")
        self.assertEqual(code, 0)
        self.assertIn("no data", out)
        self.assertNotIn(self.SECRET, out)


if __name__ == "__main__":
    unittest.main()
