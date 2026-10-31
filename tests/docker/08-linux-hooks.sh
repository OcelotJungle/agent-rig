#!/usr/bin/env bash
set -eu

. /workspace/tests/docker/common.sh
rig_test_prepare
trap rig_test_cleanup EXIT
rig_test_install

case "$(command -v claude)" in /opt/rig-fakes/claude) ;; *) rig_test_fail "fake claude is not on PATH" ;; esac
case "$(command -v codex)" in /opt/rig-fakes/codex) ;; *) rig_test_fail "fake codex is not on PATH" ;; esac

printf '%s\n' '{"hook_event_name":"Stop","session_id":"docker-reflection","cwd":"/workspace","stop_hook_active":true}' |
	python3 -X utf8 "$RIG_TEST_REPO/features/reflection/hooks/reflect.py"
python3 -I "$RIG_TEST_REPO/features/codex/tools/codex-run.py" session-hint
codex --version

if grep -Fq -- ' -p ' "$HOME/.agent-rig/fakes/claude.calls"; then
	rig_test_fail "reflection tried to make a real Claude call for its active-hook check"
fi
grep -Fq -- '--version' "$HOME/.agent-rig/fakes/codex.calls" || rig_test_fail "fake Codex did not run on Linux"
