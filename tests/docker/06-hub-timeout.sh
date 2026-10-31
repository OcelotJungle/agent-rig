#!/usr/bin/env bash
set -eu

. /workspace/tests/docker/common.sh
rig_test_prepare
trap rig_test_cleanup EXIT
rig_test_install
rig_head_before="$(git -C "$RIG_TEST_REPO" rev-parse HEAD)"
hub_head_before="$(git -C "$RIG_TEST_HUB" rev-parse HEAD)"

printf '\nRig side of pending hub restart.\n' >> "$RIG_TEST_RIG_UPSTREAM/README.md"
rig_test_push_rig "pending rig update"
printf '\nHub side of pending restart.\n' >> "$RIG_TEST_HUB_UPSTREAM/plugin/README.md"
rig_test_push_hub "pending hub update"
rig update

restarting_file="$HOME/.agent-rig/hub-restarting.json"
HUB_RESTART_TIMEOUT_MINUTES=5
TIMESTAMP_PRECISION_MARGIN_MINUTES=1
old_minutes="$((HUB_RESTART_TIMEOUT_MINUTES + TIMESTAMP_PRECISION_MARGIN_MINUTES))"
# Age both persisted timestamp inputs instead of waiting for the five-minute timeout.
restarting_at="$(date -u -d "$old_minutes minutes ago" +%Y-%m-%dT%H:%M:%SZ)"
python3 /workspace/tests/docker/age-pending-restart.py "$HOME/.agent-rig/state.json" "$restarting_at"
printf '{"time":"%s"}\n' "$restarting_at" > "$restarting_file"
touch -d "$restarting_at" "$restarting_file"

FAKE_SYSTEMCTL_HUB_WONT_START=1
export FAKE_SYSTEMCTL_HUB_WONT_START
if rig update --pending > "$RIG_TEST_ROOT/pending-timeout.log" 2>&1; then
	rig_test_fail "rig update --pending succeeded although the hub did not start"
fi
grep -Fq "Хаб не сообщил о готовности за 5 минут" "$RIG_TEST_ROOT/pending-timeout.log" || rig_test_fail "hub timeout message was not reported"

[ "$(git -C "$RIG_TEST_REPO" rev-parse HEAD)" = "$rig_head_before" ] || rig_test_fail "rig repository did not roll back after hub timeout"
[ "$(git -C "$RIG_TEST_HUB" rev-parse HEAD)" = "$hub_head_before" ] || rig_test_fail "hub repository did not roll back after hub timeout"
[ "$(cat "$HOME/.agent-rig/fakes/telegram-hub.state")" = "inactive" ] || rig_test_fail "fake hub unexpectedly came up after rollback"
grep -Fq -- '--user restart telegram-hub.service' "$HOME/.agent-rig/fakes/systemctl.calls" || rig_test_fail "rollback did not restart the hub service"
