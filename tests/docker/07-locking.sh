#!/usr/bin/env bash
set -eu

. /workspace/tests/docker/common.sh
rig_test_prepare
scenario_cleanup() {
	if [ -n "${ACTIVE_RIG_PID:-}" ]; then kill -KILL "$ACTIVE_RIG_PID" 2>/dev/null || true; fi
	if [ -f "$HOME/.agent-rig/fakes/claude.pid" ]; then
		fake_pid="$(cat "$HOME/.agent-rig/fakes/claude.pid")"
		kill -KILL "$fake_pid" 2>/dev/null || true
		rm -f "$HOME/.agent-rig/fakes/claude.pid"
	fi
	rig_test_cleanup
}
trap scenario_cleanup EXIT
rig_test_install

gate_enter="$RIG_TEST_ROOT/claude-enter.fifo"
gate_release="$RIG_TEST_ROOT/claude-release.fifo"
second_started="$RIG_TEST_ROOT/second-started.fifo"
mkfifo "$gate_enter" "$gate_release" "$second_started"
export FAKE_CLAUDE_GATE_ENTER="$gate_enter"
export FAKE_CLAUDE_GATE_RELEASE="$gate_release"

"$HOME/.local/bin/rig" feature superpowers disable > "$RIG_TEST_ROOT/first.log" 2>&1 &
ACTIVE_RIG_PID="$!"
read -r gate_message < "$gate_enter"
[ "$gate_message" = "entered" ] || rig_test_fail "first command did not enter the fake plugin gate"

(
	printf 'started\n' > "$second_started"
	exec "$HOME/.local/bin/rig" feature js-ts-rules enable
) > "$RIG_TEST_ROOT/second.log" 2>&1 &
second_pid="$!"
read -r second_message < "$second_started"
[ "$second_message" = "started" ] || rig_test_fail "second command did not start"
kill -0 "$second_pid" 2>/dev/null || rig_test_fail "second command did not wait while the first held the lock"
[ "$(rig_test_feature_flag superpowers)" = "true" ] || rig_test_fail "first command wrote feature state before finishing apply"
[ "$(rig_test_feature_flag js-ts-rules)" = "false" ] || rig_test_fail "second command changed state before acquiring the lock"

printf 'release\n' > "$gate_release"
wait "$ACTIVE_RIG_PID"
ACTIVE_RIG_PID=""
wait "$second_pid"
grep -qF "Другая команда rig работает, жду её конца." "$RIG_TEST_ROOT/second.log" || rig_test_fail "second command did not print the wait line"
unset FAKE_CLAUDE_GATE_ENTER FAKE_CLAUDE_GATE_RELEASE
[ "$(rig_test_feature_flag superpowers)" = "false" ] || rig_test_fail "first feature transition was lost"
[ "$(rig_test_feature_flag js-ts-rules)" = "true" ] || rig_test_fail "second feature transition was lost"
rig check
[ ! -e "$HOME/.agent-rig/rig.lock" ] || rig_test_fail "completed commands left a lock behind"

rm -rf "$HOME/.agent-rig/fakes/claude-gate-used"
gate_enter="$RIG_TEST_ROOT/killed-enter.fifo"
gate_release="$RIG_TEST_ROOT/killed-release.fifo"
mkfifo "$gate_enter" "$gate_release"
export FAKE_CLAUDE_GATE_ENTER="$gate_enter"
export FAKE_CLAUDE_GATE_RELEASE="$gate_release"
"$HOME/.local/bin/rig" feature superpowers enable > "$RIG_TEST_ROOT/killed.log" 2>&1 &
ACTIVE_RIG_PID="$!"
read -r gate_message < "$gate_enter"
[ "$gate_message" = "entered" ] || rig_test_fail "gated process did not reach fake claude"
fake_claude_pid="$(cat "$HOME/.agent-rig/fakes/claude.pid")"
kill -KILL "$ACTIVE_RIG_PID" 2>/dev/null || true
kill -KILL "$fake_claude_pid" 2>/dev/null || true
rm -f "$HOME/.agent-rig/fakes/claude.pid"
ACTIVE_RIG_PID=""
unset FAKE_CLAUDE_GATE_ENTER FAKE_CLAUDE_GATE_RELEASE

rig apply
[ ! -e "$HOME/.agent-rig/rig.lock" ] || rig_test_fail "next command did not reclaim the killed process lock"
