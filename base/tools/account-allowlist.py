"""Per-category allowlist of claude-swap (cswap) account numbers; loaded by path by the agent run launchers.

Config: ~/.agent-rig/account-allowlist.json, `{"codex": [1, 4], "volunteers": [1, 4]}`.
  - no file, or a category key missing: that category is unrestricted
  - a category list present: the session's cswap account number must be in it
Account of the session:
  - ~/.claude-swap-backup/sequence.json missing: no cswap, the account is unknown and nothing is restricted
  - CLAUDE_CONFIG_DIR unset or the main ~/.claude: the main login, `activeAccountNumber` of sequence.json
  - CLAUDE_CONFIG_DIR = .../sessions/<N>-<name>: account N
  - anything else (unreadable sequence.json, a profile dir without a number): unknown, so a restricted category fails closed
Malformed config: every category is refused, naming the file.
Query from outside (the telegram hub's /info):
  python -I account-allowlist.py check <codex|volunteers> --config-dir <dir>
prints {"allowed": bool, "reason": str} as one JSON line; an empty or omitted --config-dir is the main login.
Owner of a cswap account (the session launchers' owner lookup):
  python -I account-allowlist.py owner --account <N>
prints {"accountUuid": str, "organizationUuid": str} from accounts[N] of sequence.json, or {"error": str}; exit 0 in both cases.
"""
import argparse
import json
import os
import re
from pathlib import Path

# cswap names a side profile dir "<account number>-<name>"
PROFILE_NAME = re.compile(r"^([0-9]+)-")
DECIMAL = re.compile(r"[0-9]+")
# output key -> field of one account in cswap's sequence.json
OWNER_FIELDS = (("accountUuid", "uuid"), ("organizationUuid", "organizationUuid"))

SEQUENCE_PARTS = (".claude-swap-backup", "sequence.json")
MAIN_PROFILE = ".claude"
CATEGORIES = ("codex", "volunteers")
CONFIG_DISPLAY = "~/.agent-rig/account-allowlist.json"


def config_path(home):
    return Path(home) / ".agent-rig" / "account-allowlist.json"


def _read_sequence(home):
    """(cswap_present, sequence dict or None)."""
    path = Path(home) / SEQUENCE_PARTS[0] / SEQUENCE_PARTS[1]
    if not path.is_file():
        return False, None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return True, None
    return True, data if isinstance(data, dict) else None


def _is_number(value):
    return isinstance(value, int) and not isinstance(value, bool)


def account_number(text):
    """argparse type: a decimal cswap account number; leading zeros name the same account ("04" is 4)."""
    if not DECIMAL.fullmatch(text):
        raise argparse.ArgumentTypeError("must be a decimal account number, for example 4")
    return int(text)


def owner(number, home=None):
    """{"accountUuid", "organizationUuid"} of cswap account `number`, or {"error": text}."""
    home = Path.home() if home is None else Path(home)
    present, sequence = _read_sequence(home)
    if not present:
        return {"error": "cswap sequence.json not found"}
    if sequence is None:
        return {"error": "cswap sequence.json is unreadable or not a JSON object"}
    accounts = sequence.get("accounts")
    if not isinstance(accounts, dict):
        return {"error": "cswap sequence.json has no accounts object"}
    entry = accounts.get(str(number))
    if not isinstance(entry, dict):
        return {"error": f"account {number} is not in cswap sequence.json"}
    result = {}
    for key, field in OWNER_FIELDS:
        value = entry.get(field)
        if not isinstance(value, str) or not value:
            return {"error": f"accounts[{number}].{field} is missing or empty in cswap sequence.json"}
        result[key] = value
    return result


def current_account(env=None, home=None):
    """(cswap_present, account number or None when it cannot be determined)."""
    env = os.environ if env is None else env
    home = Path.home() if home is None else Path(home)
    present, sequence = _read_sequence(home)
    if not present:
        return False, None
    profile = env.get("CLAUDE_CONFIG_DIR")
    main = True
    if profile:
        try:
            main = Path(profile).resolve() == (home / MAIN_PROFILE).resolve()
        except OSError:
            main = False
    if main:
        number = (sequence or {}).get("activeAccountNumber")
        return True, number if _is_number(number) else None
    match = PROFILE_NAME.match(Path(profile).name)
    return True, int(match.group(1)) if match else None


def load_config(home):
    """(config dict, error text or None). A missing file is an empty config."""
    path = config_path(home)
    if not path.is_file():
        return {}, None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return {}, f"{CONFIG_DISPLAY} is malformed ({e.__class__.__name__}); fix or delete it"
    if not isinstance(data, dict):
        return {}, f"{CONFIG_DISPLAY} is malformed (the top level must be an object); fix or delete it"
    for category in CATEGORIES:
        if category in data and not (isinstance(data[category], list) and all(_is_number(n) for n in data[category])):
            return {}, f'{CONFIG_DISPLAY} is malformed ("{category}" must be a list of account numbers); fix or delete it'
    return data, None


def check(category, env=None, home=None):
    """(allowed, reason). The reason is empty when allowed."""
    home = Path.home() if home is None else Path(home)
    config, error = load_config(home)
    if error:
        return False, f"REFUSED: {category} is blocked: {error}"
    allowed = config.get(category)
    if allowed is None:
        return True, ""
    present, number = current_account(env, home)
    if not present:
        return True, ""
    listed = ", ".join(str(n) for n in allowed) or "none"
    if number is None:
        return False, (f"REFUSED: {category} is limited to cswap accounts [{listed}] by {CONFIG_DISPLAY}, "
                       "but the account of this session cannot be determined")
    if number not in allowed:
        return False, (f"REFUSED: {category} is not allowed on cswap account {number} "
                       f"(allowed: {listed}; set in {CONFIG_DISPLAY})")
    return True, ""


def refuse_if_blocked(category, env=None, home=None):
    """Exit with the refusal text when the category is blocked on this account."""
    allowed, reason = check(category, env, home)
    if not allowed:
        raise SystemExit(reason)


def session_hint(category, hint, env=None, home=None, out=None):
    """Print the SessionStart hook output carrying `hint` when the category is blocked on this account."""
    allowed, reason = check(category, env, home)
    if allowed:
        return
    text = json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                              "additionalContext": f"{hint} ({reason})"}}, ensure_ascii=True)
    print(text, file=out)


def build_parser():
    parser = argparse.ArgumentParser(description="Query the cswap account allowlist.")
    commands = parser.add_subparsers(dest="command", required=True)
    query = commands.add_parser("check", help="print whether a category is allowed for a Claude config dir")
    query.add_argument("category", choices=CATEGORIES)
    query.add_argument("--config-dir", default="",
                       help="the CLAUDE_CONFIG_DIR of the session; empty or omitted is the main login")
    batch =commands.add_parser("batch", help="query accounts and categories in one process")
    batch.add_argument("--config-dir", action="append", required=True)
    batch.add_argument("--category", action="append", choices=CATEGORIES, default=[])
    owner_parser = commands.add_parser("owner", help="print the accountUuid and organizationUuid of a cswap account")
    owner_parser.add_argument("--account", type=account_number, required=True, help="the cswap account number")
    return parser


def main(argv=None):
    """`check <category> --config-dir <dir>`: one line of JSON {"allowed", "reason"}, exit 0 in both cases.
    `batch --config-dir <dir>... [--category <name>...]`: one line of JSON {"accounts", "categories"}; accounts maps
    each dir to {"present", "account"} (account is null when unknown) and categories maps each category to
    {"allowed", "reason"}. An item whose check raised is {"error": text} instead; the other items are unaffected.
    `owner --account <N>`: one line of JSON {"accountUuid", "organizationUuid"} of cswap account N, or {"error": text}.

    The process's own CLAUDE_CONFIG_DIR is ignored: --config-dir alone names the session's config dir.
    """
    args = build_parser().parse_args(argv)
    if args.command == "owner":
        print(json.dumps(owner(args.account), ensure_ascii=True))
        return 0
    if args.command == "batch":
        accounts = {}
        for directory in args.config_dir:
            env = {"CLAUDE_CONFIG_DIR": directory} if directory else {}
            try:
                present, number = current_account(env)
                accounts[directory] = {"present": present, "account": number}
            except Exception as e:  # one bad directory must not fail the others
                accounts[directory] = {"error": f"{e.__class__.__name__}: {e}"}
        env = {"CLAUDE_CONFIG_DIR": args.config_dir[0]} if args.config_dir[0] else {}
        categories = {}
        for category in args.category:
            try:
                allowed, reason = check(category, env)
                categories[category] = {"allowed": allowed, "reason": reason}
            except Exception as e:  # one failing category must not fail the others
                categories[category] = {"error": f"{e.__class__.__name__}: {e}"}
        print(json.dumps({"accounts": accounts, "categories": categories}, ensure_ascii=True))
        return 0
    env = {"CLAUDE_CONFIG_DIR": args.config_dir} if args.config_dir else {}
    allowed, reason = check(args.category, env)
    print(json.dumps({"allowed": allowed, "reason": reason}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
