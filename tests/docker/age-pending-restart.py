#!/usr/bin/env python3
"""Age the persisted restart boundary for a timeout scenario without sleeping."""
import json
import sys
from pathlib import Path

state_path = Path(sys.argv[1])
restart_after = sys.argv[2]
state = json.loads(state_path.read_text(encoding="utf-8"))
pending = json.loads(state["pendingHubRestart"])
pending["restartAfter"] = restart_after
# The timeout accepts a restarting signal only from the moment the wait started, so that moment ages too.
pending["startedAt"] = restart_after
state["pendingHubRestart"] = json.dumps(pending, separators=(",", ":"))
state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
