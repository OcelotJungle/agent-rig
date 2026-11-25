"""Facts about claude-swap (cswap) accounts, read from its files; used by the session launchers and the telegram hub.

Account of a session (`batch`):
  - ~/.claude-swap-backup/sequence.json missing: no cswap, the account is unknown
  - CLAUDE_CONFIG_DIR unset or the main ~/.claude: the main login, `activeAccountNumber` of sequence.json
  - CLAUDE_CONFIG_DIR = .../sessions/<N>-<name>: account N
  - anything else (unreadable sequence.json, a profile dir without a number): unknown (account null)
Query from outside (the telegram hub's /info):
  python -I cswap-account.py batch --config-dir <dir>...
prints {"accounts": {"<dir>": {"present": bool, "account": int|null} | {"error": str}}} as one JSON line; an empty
--config-dir is the main login.
Owner of a cswap account (the session launchers' owner lookup):
  python -I cswap-account.py owner --account <N>
prints {"accountUuid": str, "organizationUuid": str} from accounts[N] of sequence.json, or {"error": str}; exit 0 in both cases.
Config of a cswap account (where `cswap run N` keeps the per-folder consent of the session it starts):
  python -I cswap-account.py config-dir --account <N>
prints {"dir": str, "file": str, "isDefault": bool, "exists": bool} (forward slashes), or {"error": str}; exit 0 in both
cases. Mirrors cswap's `run` (claude_swap/session.py): with no CLAUDE_CONFIG_DIR, an account whose email and organization
equal the default config's oauthAccount runs on the default config (~/.claude.json, or the legacy ~/.claude/.config.json
when it exists); any other account runs on ~/.claude-swap-backup/sessions/<N>-<slugify_email(email)>/.claude.json.
`exists` is whether that config file exists. Nothing is created.
"""
import argparse
import json
import os
import re
import unicodedata
from pathlib import Path

# cswap names a side profile dir "<account number>-<name>"
PROFILE_NAME = re.compile(r"^([0-9]+)-")
DECIMAL = re.compile(r"[0-9]+")
# output key -> field of one account in cswap's sequence.json
OWNER_FIELDS = (("accountUuid", "uuid"), ("organizationUuid", "organizationUuid"))

SEQUENCE_PARTS = (".claude-swap-backup", "sequence.json")
SESSIONS_PARTS = (".claude-swap-backup", "sessions")
CLAUDE_JSON = ".claude.json"
LEGACY_CONFIG_JSON = ".config.json"
MAIN_PROFILE = ".claude"


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


def slugify_email(email):
    """cswap's `slugify_email` (claude_swap/session.py): NFC, then every character outside [A-Za-z0-9._-] becomes "_"."""
    normalized = unicodedata.normalize("NFC", email)
    return "".join(ch if (ch.isascii() and (ch.isalnum() or ch in "._-")) else "_" for ch in normalized)


def _default_config_file(home):
    """cswap's `get_default_global_config_path`: the legacy ~/.claude/.config.json when it exists, else ~/.claude.json."""
    legacy = home / MAIN_PROFILE / LEGACY_CONFIG_JSON
    return legacy if legacy.exists() else home / CLAUDE_JSON


def _default_identity(file):
    """(email, organization uuid) of the default login in its config file, or None when there is none. cswap's
    `_get_current_identity_triple`: a null organization is the empty string."""
    try:
        data = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    account = data.get("oauthAccount") if isinstance(data, dict) else None
    if not isinstance(account, dict):
        return None
    email = account.get("emailAddress")
    if not isinstance(email, str) or not email:
        return None
    organization = account.get("organizationUuid")
    return email, organization if isinstance(organization, str) else ""


def config_dir(number, home=None):
    """{"dir", "file", "isDefault", "exists"} of the config `cswap run <number>` starts Claude with, or {"error": text}."""
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
    email = entry.get("email")
    if not isinstance(email, str) or not email:
        return {"error": f"accounts[{number}].email is missing or empty in cswap sequence.json"}
    organization = entry.get("organizationUuid")
    organization = organization if isinstance(organization, str) else ""
    default_file = _default_config_file(home)
    if _default_identity(default_file) == (email, organization):
        return {"dir": default_file.parent.as_posix(), "file": default_file.as_posix(), "isDefault": True, "exists": True}
    directory = home.joinpath(*SESSIONS_PARTS, f"{number}-{slugify_email(email)}")
    file = directory / CLAUDE_JSON
    return {"dir": directory.as_posix(), "file": file.as_posix(), "isDefault": False, "exists": file.is_file()}


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


def build_parser():
    parser = argparse.ArgumentParser(description="Facts about claude-swap accounts.")
    commands = parser.add_subparsers(dest="command", required=True)
    batch = commands.add_parser("batch", help="the cswap account of each Claude config dir, in one process")
    batch.add_argument("--config-dir", action="append", required=True)
    owner_parser = commands.add_parser("owner", help="print the accountUuid and organizationUuid of a cswap account")
    owner_parser.add_argument("--account", type=account_number, required=True, help="the cswap account number")
    config_parser = commands.add_parser("config-dir", help="print where `cswap run N` keeps the config of a cswap account")
    config_parser.add_argument("--account", type=account_number, required=True, help="the cswap account number")
    return parser


def main(argv=None):
    """`batch --config-dir <dir>...`: one line of JSON {"accounts"}; accounts maps each dir to {"present", "account"}
    (account is null when unknown), or to {"error": text} when its lookup raised; the other dirs are unaffected.
    `owner --account <N>`: one line of JSON {"accountUuid", "organizationUuid"} of cswap account N, or {"error": text}.

    `config-dir --account <N>`: one line of JSON {"dir", "file", "isDefault", "exists"} of the config `cswap run N` uses, or {"error": text}.

    The process's own CLAUDE_CONFIG_DIR is ignored: --config-dir alone names the session's config dir.
    """
    args = build_parser().parse_args(argv)
    if args.command == "config-dir":
        print(json.dumps(config_dir(args.account), ensure_ascii=True))
        return 0
    if args.command == "owner":
        print(json.dumps(owner(args.account), ensure_ascii=True))
        return 0
    accounts = {}
    for directory in args.config_dir:
        env = {"CLAUDE_CONFIG_DIR": directory} if directory else {}
        try:
            present, number = current_account(env)
            accounts[directory] = {"present": present, "account": number}
        except Exception as e:  # one bad directory must not fail the others
            accounts[directory] = {"error": f"{e.__class__.__name__}: {e}"}
    print(json.dumps({"accounts": accounts}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
