"""Find free cloud models that can call tools, for the volunteer executor.

Commands:
  limits [--json] [--proxy-url URL] [--token-file F] [--quota-file F] [--models-file F]
          approximate daily usage of the free models from the proxy's /status (fallback:
          freellmpool's quota.json); no model requests, always exit 0.
  refresh --proxy-url URL --token-file F [--cache F] [--max-requests N] [--timeout S]
          list the freellmpool proxy's models, keep only allowed providers and verified-free
          models, smoke-test each one pinned as provider/model (one function-tool request),
          write the ordered result to the cache (default ~/.claude/volunteer-jobs/models.json).

Cache: {"checked_at": ISO UTC, "models": [{"id", "agent": "full"|"minimal", "latency_s"}],
        "rejected": [{"id", "reason"}]}; `models` is in preferred order. The file is replaced
atomically; a lock file next to it stops two refreshes from running at once.
Exit codes: 0 ok, 1 no working model found (cache still written), 2 proxy unusable,
3 another refresh holds the lock.
"""
import argparse
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_CACHE = Path.home() / ".claude" / "volunteer-jobs" / "models.json"
OPENROUTER_LIST_URL = "https://openrouter.ai/api/v1/models"
REQUESTY_LIST_URL = "https://router.requesty.ai/v1/models"

# Keyless providers (pollinations, ovh, kilo, opencode, llm7) are not used: nobody knows who stores the requests. The
# gemini adapter has no tools; everything outside this set is ignored.
ALLOWED_PROVIDERS = ("openrouter", "groq", "requesty", "zhipu")
# Groq's free tier allows 8000 tokens per minute: only the stripped-down agent fits.
MINIMAL_AGENT_PROVIDERS = ("groq",)
# Tried first, in this order, when they pass.
FAVORITES = (
    "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    "openrouter/cohere/north-mini-code:free",
)
ROUTER_MODEL_ID = "openrouter/free"
FREE_SUFFIX = ":free"

MIN_CONTEXT = 64000
MAX_REQUESTS = 25
SMOKE_TIMEOUT_S = 60
LIST_TIMEOUT_S = 30
MAX_TOKENS = 1024
LOCK_STALE_S = 30 * 60
LATENCY_DIGITS = 2

SMOKE_TOOL_NAME = "get_weather"
SMOKE_PROMPT = "What is the weather in Paris right now? You must call the get_weather tool."
SMOKE_TOOL = {
    "type": "function",
    "function": {
        "name": SMOKE_TOOL_NAME,
        "description": "Get the current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "City name"}},
            "required": ["city"],
        },
    },
}

DEFAULT_PROXY_URL = "http://127.0.0.1:18080"
DEFAULT_TOKEN_FILE = Path.home() / ".claude" / "volunteer-jobs" / "proxy-token"
# freellmpool's daily counters: {"YYYY-MM-DD" (UTC): {"provider::model": count}}.
DEFAULT_QUOTA_FILE = Path.home() / ".config" / "freellmpool" / "quota.json"
STATUS_TIMEOUT_S = 5
# Providers counted in the overall day percentage (keyless ones and gemini never are) plus zhipu,
# whose real cap is unknown: it is shown as a count only.
LIMIT_PROVIDERS = ("openrouter", "requesty", "groq", "zhipu")
# OpenRouter's free cap is per ACCOUNT, across all :free models: 1000/day once >= 10 credits
# were ever bought (the account has). The proxy's per-model rpd=1000 would overcount.
OPENROUTER_DAY_CAP = 1000
# Requesty: 200 requests/day per account across all models (confirmed by docs.requesty.ai,
# "Can I try Requesty for free?").
REQUESTY_DAY_CAP = 200
# Groq caps are per model. Groq does not publish its free-plan limits (the docs table is the
# Developer plan; free limits are only in the account console), so the proxy catalog's rpd is
# UNVERIFIED. The quota file has no rpd, so GROQ_DEFAULT_RPD (the proxy's value) stands in there.
# Put real console values in GROQ_RPD_OVERRIDE, {model name without "groq/": rpd}; it wins.
GROQ_DEFAULT_RPD = 1000
GROQ_RPD_OVERRIDE = {}

EXIT_OK = 0
EXIT_NO_MODELS = 1
EXIT_PROXY = 2
EXIT_LOCKED = 3


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def http_json(url, token=None, body=None, timeout=LIST_TIMEOUT_S):
    """GET (or POST when body is given) JSON. Returns (status, parsed or None, error text)."""
    headers = {"Accept": "application/json"}
    data = None
    if token:
        headers["Authorization"] = "Bearer " + token
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        return e.code, None, "http %d" % e.code
    except TimeoutError:
        return 0, None, "timeout"
    except urllib.error.URLError as e:
        if isinstance(e.reason, TimeoutError):
            return 0, None, "timeout"
        return 0, None, "connection error: %s" % short(str(e.reason))
    except OSError as e:
        if "timed out" in str(e):
            return 0, None, "timeout"
        return 0, None, "connection error: %s" % short(str(e))
    try:
        return status, json.loads(raw.decode("utf-8")), ""
    except ValueError:
        return status, None, "invalid JSON in response"


def short(text, n=80):
    text = " ".join(str(text).split())
    return text if len(text) <= n else text[: n - 3] + "..."


def provider_of(model_id):
    return model_id.split("/", 1)[0] if "/" in model_id else ""


def is_zero(value):
    """True for a price that is exactly zero ("0", 0, "0.0"); None or junk is not zero."""
    if value is None or isinstance(value, bool):
        return False
    try:
        return float(value) == 0.0
    except (TypeError, ValueError):
        return False


def openrouter_free_ids(listing):
    """Proxy ids ("openrouter/<id>") of OpenRouter's verified-free tool-capable models."""
    result = set()
    for m in listing.get("data", []) if isinstance(listing, dict) else []:
        if not isinstance(m, dict):
            continue
        mid = m.get("id")
        if not isinstance(mid, str) or not mid.endswith(FREE_SUFFIX) or mid == "openrouter/free":
            continue
        pricing = m.get("pricing") or {}
        if not (is_zero(pricing.get("prompt")) and is_zero(pricing.get("completion"))):
            continue
        if "tools" not in (m.get("supported_parameters") or []):
            continue
        ctx = m.get("context_length")
        if not isinstance(ctx, (int, float)) or ctx < MIN_CONTEXT:
            continue
        result.add("openrouter/" + mid)
    return result


def requesty_free_ids(listing):
    """Proxy ids ("requesty/<id>") of Requesty models whose every price is verifiably zero."""
    result = set()
    for m in listing.get("data", []) if isinstance(listing, dict) else []:
        if not isinstance(m, dict):
            continue
        mid = m.get("id")
        if not isinstance(mid, str) or m.get("api", "chat") != "chat":
            continue
        if not (is_zero(m.get("input_price")) and is_zero(m.get("output_price"))):
            continue
        if m.get("caching_price") is not None and not is_zero(m.get("caching_price")):
            continue
        tiers = m.get("pricing") or []
        if not all(
            isinstance(t, dict) and is_zero(t.get("input_price")) and is_zero(t.get("output_price"))
            for t in tiers
        ):
            continue
        if m.get("supports_tool_calling") is not True:
            continue
        ctx = m.get("context_window")
        if not isinstance(ctx, (int, float)) or ctx < MIN_CONTEXT:
            continue
        result.add("requesty/" + mid)
    return result


def select_candidates(proxy_ids, openrouter_free, requesty_free):
    """Filter the proxy's model ids down to testable candidates. A None free-set means the
    public listing was unavailable, so that provider's models cannot be verified and are dropped."""
    out = []
    for mid in proxy_ids:
        prov = provider_of(mid)
        if prov not in ALLOWED_PROVIDERS or mid == ROUTER_MODEL_ID:
            continue
        if prov == "openrouter" and (openrouter_free is None or mid not in openrouter_free):
            continue
        if prov == "requesty" and (requesty_free is None or mid not in requesty_free):
            continue
        if mid not in out:
            out.append(mid)
    return out


def test_order(candidates):
    """Order for spending the request cap: favorites, then providers interleaved."""
    favs = [m for m in FAVORITES if m in candidates]
    rest = [m for m in candidates if m not in favs]
    by_prov = {p: [m for m in rest if provider_of(m) == p] for p in ALLOWED_PROVIDERS}
    mixed = []
    while any(by_prov.values()):
        for p in ALLOWED_PROVIDERS:
            if by_prov[p]:
                mixed.append(by_prov[p].pop(0))
    return favs + mixed


def smoke_test(proxy_url, token, model_id, timeout=SMOKE_TIMEOUT_S):
    """One chat completion with one function tool. Returns (ok, latency_s, reason)."""
    body = {
        "model": model_id,
        "messages": [{"role": "user", "content": SMOKE_PROMPT}],
        "tools": [SMOKE_TOOL],
        "max_tokens": MAX_TOKENS,
    }
    start = time.monotonic()
    status, data, err = http_json(proxy_url.rstrip("/") + "/v1/chat/completions", token, body, timeout)
    latency = round(time.monotonic() - start, LATENCY_DIGITS)
    if err:
        return False, latency, err
    if latency > timeout:
        return False, latency, "timeout"
    try:
        message = data["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return False, latency, "malformed response"
    calls = message.get("tool_calls") if isinstance(message, dict) else None
    if not isinstance(calls, list) or not calls:
        return False, latency, "no tool call"
    fn = calls[0].get("function") if isinstance(calls[0], dict) else None
    if not isinstance(fn, dict) or fn.get("name") != SMOKE_TOOL_NAME:
        return False, latency, "wrong tool call"
    try:
        args = json.loads(fn.get("arguments") or "")
    except (TypeError, ValueError):
        return False, latency, "invalid tool arguments"
    if not isinstance(args, dict):
        return False, latency, "invalid tool arguments"
    return True, latency, ""


def order_models(passed):
    """passed: list of (id, latency_s). Favorites, then non-minimal by latency, minimal last."""
    by_id = dict(passed)
    result = [m for m in FAVORITES if m in by_id]
    rest = [(lat, mid) for mid, lat in passed if mid not in result]
    full = sorted((lat, mid) for lat, mid in rest if provider_of(mid) not in MINIMAL_AGENT_PROVIDERS)
    minimal = sorted((lat, mid) for lat, mid in rest if provider_of(mid) in MINIMAL_AGENT_PROVIDERS)
    result += [mid for _, mid in full] + [mid for _, mid in minimal]
    return [
        {
            "id": mid,
            "agent": "minimal" if provider_of(mid) in MINIMAL_AGENT_PROVIDERS else "full",
            "latency_s": by_id[mid],
        }
        for mid in result
    ]


def write_cache(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def acquire_lock(path):
    """Create the lock file exclusively. A lock older than LOCK_STALE_S is a crashed refresh."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    for _ in range(2):
        try:
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                age = time.time() - path.stat().st_mtime
            except OSError:
                continue
            if age < LOCK_STALE_S:
                return False
            try:
                path.unlink()
            except OSError:
                return False
            continue
        with os.fdopen(fd, "w") as f:
            f.write(str(os.getpid()))
        return True
    return False


def release_lock(path):
    try:
        Path(path).unlink()
    except OSError:
        pass


def listing_windows(listing, prefix, key):
    """Context windows by proxy id ("<prefix>/<listing id>") from a public listing; `key` is the window field."""
    result = {}
    for m in listing.get("data", []) if isinstance(listing, dict) else []:
        if isinstance(m, dict) and isinstance(m.get("id"), str) and isinstance(m.get(key), (int, float)):
            result[prefix + "/" + m["id"]] = int(m[key])
    return result


def add_windows(models, windows):
    """Add "context" (tokens) to each model whose window is known; the supervisor skips models too small for a session."""
    for m in models:
        if m["id"] in windows:
            m["context"] = windows[m["id"]]
    return models


def fetch_free_set(url, extract, label, rejected, windows=None, prefix="", key=""):
    status, data, err = http_json(url)
    if err or data is None:
        rejected.append({"id": label + "/*", "reason": "public listing unavailable: " + (err or "empty")})
        return None
    if windows is not None:
        windows.update(listing_windows(data, prefix, key))
    return extract(data)


def refresh(a):
    token = Path(a.token_file).read_text(encoding="utf-8").strip()
    cache = Path(a.cache)
    lock = cache.with_name(cache.name + ".lock")
    if not acquire_lock(lock):
        print("another refresh is running (lock: %s)" % lock)
        return EXIT_LOCKED
    try:
        return do_refresh(a, token, cache)
    finally:
        release_lock(lock)


def do_refresh(a, token, cache):
    proxy = a.proxy_url.rstrip("/")
    status, data, err = http_json(proxy + "/v1/models", token)
    if err or not isinstance(data, dict) or not isinstance(data.get("data"), list):
        print("proxy unusable: %s" % (err or "unexpected /v1/models response"))
        return EXIT_PROXY
    proxy_ids = [m["id"] for m in data["data"] if isinstance(m, dict) and isinstance(m.get("id"), str)]
    rejected = []
    windows = {}
    or_free = fetch_free_set(a.openrouter_url, openrouter_free_ids, "openrouter", rejected,
                             windows, "openrouter", "context_length")
    rq_free = fetch_free_set(a.requesty_url, requesty_free_ids, "requesty", rejected,
                             windows, "requesty", "context_window")
    candidates = test_order(select_candidates(proxy_ids, or_free, rq_free))
    passed = []
    for i, mid in enumerate(candidates):
        if i >= a.max_requests:
            rejected.append({"id": mid, "reason": "not checked (request cap %d)" % a.max_requests})
            continue
        ok, latency, reason = smoke_test(proxy, token, mid, a.timeout)
        if ok:
            passed.append((mid, latency))
        else:
            rejected.append({"id": mid, "reason": reason})
    models = add_windows(order_models(passed), windows)
    write_cache(cache, {"checked_at": now_iso(), "models": models, "rejected": rejected})
    print("candidates: %d, working: %d, rejected: %d -> %s" % (len(candidates), len(models), len(rejected), cache))
    for m in models:
        print("  ok   %s  %s  %.1fs" % (m["id"], m["agent"], m["latency_s"]))
    for r in rejected:
        print("  fail %s  %s" % (r["id"], r["reason"]))
    return EXIT_OK if models else EXIT_NO_MODELS


def read_proxy_rows(proxy_url, token_file):
    """Per-model counters from the proxy's /status. Returns (rows, error); rows is a list of
    (provider, model, used_today, rpd)."""
    try:
        token = Path(token_file).read_text(encoding="utf-8").strip()
    except OSError as e:
        return None, "token file unreadable: %s" % short(e.strerror or e)
    status, data, err = http_json(proxy_url.rstrip("/") + "/status", token, timeout=STATUS_TIMEOUT_S)
    if err:
        return None, "proxy: " + err
    providers = data.get("providers") if isinstance(data, dict) else None
    if not isinstance(providers, list):
        return None, "proxy: unexpected /status response"
    rows = []
    for p in providers:
        if not isinstance(p, dict) or not isinstance(p.get("id"), str):
            continue
        for m in p.get("models") or []:
            if isinstance(m, dict) and isinstance(m.get("name"), str):
                rows.append((p["id"], m["name"], as_count(m.get("used_today")), as_count(m.get("rpd"))))
    return rows, ""


def read_quota_rows(quota_file, now):
    """Today's counters from freellmpool's quota.json: {"YYYY-MM-DD": {"provider::model": n}}
    (the day is UTC). The file has no rpd, so rpd is 0 here."""
    try:
        data = json.loads(Path(quota_file).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, "quota file missing"
    except (OSError, ValueError):
        return None, "quota file unreadable"
    day = data.get(now.strftime("%Y-%m-%d")) if isinstance(data, dict) else None
    if day is None:
        return [], ""
    if not isinstance(day, dict):
        return None, "quota file malformed"
    rows = []
    for key, n in day.items():
        if isinstance(key, str) and "::" in key:
            prov, model = key.split("::", 1)
            rows.append((prov, model, as_count(n), 0))
    return rows, ""


def as_count(value):
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0 else 0


def groq_models_in_cache(models_file):
    """Groq model names (without the "groq/" prefix) listed in the models cache."""
    try:
        data = json.loads(Path(models_file).read_text(encoding="utf-8"))
        ids = [m["id"] for m in data["models"]]
    except (OSError, ValueError, KeyError, TypeError):
        return set()
    return {i[len("groq/"):] for i in ids if isinstance(i, str) and i.startswith("groq/")}


def aggregate(rows, groq_names):
    """Approximate daily usage. Returns (providers, used, cap); see the cap constants above."""
    used = {p: 0 for p in LIMIT_PROVIDERS}
    groq_cap = 0
    for prov, model, n, rpd in rows:
        if prov not in LIMIT_PROVIDERS:
            continue
        if prov == "groq":
            if model not in groq_names:
                continue
            groq_cap += GROQ_RPD_OVERRIDE.get(model) or rpd or GROQ_DEFAULT_RPD
        used[prov] += n
    providers = {
        "openrouter": {"used": used["openrouter"], "cap": OPENROUTER_DAY_CAP},
        "requesty": {"used": used["requesty"], "cap": REQUESTY_DAY_CAP},
        "groq": {"used": used["groq"], "cap": groq_cap},
        "zhipu": {"used": used["zhipu"], "cap": None},
    }
    total_used = sum(v["used"] for v in providers.values() if v["cap"] is not None)
    total_cap = sum(v["cap"] for v in providers.values() if v["cap"] is not None)
    return providers, total_used, total_cap


def seconds_to_utc_midnight(now):
    nxt = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return int((nxt - now).total_seconds())


def compute_limits(a, now=None):
    now = now or datetime.now(timezone.utc)
    result = {
        "checked_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "none",
        "day_percent": None,
        "used": None,
        "cap": None,
        "reset_in_s": seconds_to_utc_midnight(now),
        "providers": {},
        "error": None,
    }
    rows, perr = read_proxy_rows(a.proxy_url, a.token_file)
    source = "proxy"
    if rows is None:
        rows, qerr = read_quota_rows(a.quota_file, now)
        source = "quota-file"
        if rows is None:
            result["error"] = "%s; %s" % (perr, qerr)
            return result
    providers, used, cap = aggregate(rows, groq_models_in_cache(a.models_file))
    result.update(
        source=source,
        day_percent=round(used * 100 / cap) if cap else 0,
        used=used,
        cap=cap,
        providers=providers,
    )
    return result


def format_duration(seconds):
    minutes = max(seconds, 0) // 60
    return "%d ч %d мин" % (minutes // 60, minutes % 60)


def format_limits(r):
    if r["source"] == "none":
        return "**Лимиты волонтёров**\nнет данных: %s" % r["error"]
    note = "данные сейчас" if r["source"] == "proxy" else "по счётчикам freellmpool"
    names = (("openrouter", "OpenRouter"), ("requesty", "Requesty"), ("groq", "Groq"))
    parts = ["%s %d/%d" % (title, r["providers"][k]["used"], r["providers"][k]["cap"]) for k, title in names]
    parts.append("Z.ai %d запр." % r["providers"]["zhipu"]["used"])
    return "**Лимиты волонтёров** (%s)\nДень: %d%% (сброс через %s)\n%s" % (
        note,
        r["day_percent"],
        format_duration(r["reset_in_s"]),
        " · ".join(parts),
    )


def limits(a):
    r = compute_limits(a)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if a.json:
        print(json.dumps(r, ensure_ascii=False))
    else:
        print(format_limits(r))
    return EXIT_OK


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    lim = sub.add_parser("limits", help="approximate daily usage of the free models (no model requests)")
    lim.add_argument("--json", action="store_true")
    lim.add_argument("--proxy-url", default=DEFAULT_PROXY_URL)
    lim.add_argument("--token-file", default=str(DEFAULT_TOKEN_FILE))
    lim.add_argument("--quota-file", default=str(DEFAULT_QUOTA_FILE))
    lim.add_argument("--models-file", default=str(DEFAULT_CACHE))
    r = sub.add_parser("refresh", help="rebuild the model cache")
    r.add_argument("--proxy-url", required=True)
    r.add_argument("--token-file", required=True)
    r.add_argument("--cache", default=str(DEFAULT_CACHE))
    r.add_argument("--max-requests", type=int, default=MAX_REQUESTS)
    r.add_argument("--timeout", type=float, default=SMOKE_TIMEOUT_S)
    r.add_argument("--openrouter-url", default=OPENROUTER_LIST_URL)
    r.add_argument("--requesty-url", default=REQUESTY_LIST_URL)
    a = ap.parse_args(argv)
    if a.cmd == "limits":
        return limits(a)
    return refresh(a)


if __name__ == "__main__":
    sys.exit(main())
