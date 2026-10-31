#!/usr/bin/env bash
set -eu

. /workspace/tests/docker/common.sh
rig_test_prepare
trap rig_test_cleanup EXIT
rig_test_install

printf '\nSuccessful update fixture.\n' >> "$RIG_TEST_RIG_UPSTREAM/README.md"
rig_test_push_rig "successful update fixture"
rig update
successful_commit="$(git -C "$RIG_TEST_RIG_UPSTREAM" rev-parse HEAD)"
[ "$(git -C "$RIG_TEST_REPO" rev-parse HEAD)" = "$successful_commit" ] || rig_test_fail "new rig commit was not applied"

hook="$RIG_TEST_RIG_UPSTREAM/base/hooks/project-tmp.sh"
# The broken line goes right after the shebang: the script's final `exit` would otherwise make it unreachable.
hook_body="$(tail -n +2 "$hook")"
printf '#!/usr/bin/env bash\nprintf "broken hook ran\\n" >> "$HOME/.agent-rig/broken-hook-runs"\nexit 1\n%s\n' "$hook_body" > "$hook"
rig_test_push_rig "broken hook fixture"
broken_commit="$(git -C "$RIG_TEST_RIG_UPSTREAM" rev-parse HEAD)"
if rig update > "$RIG_TEST_ROOT/broken-update.log" 2>&1; then
	cat "$RIG_TEST_ROOT/broken-update.log" >&2
	rig_test_fail "update accepted a commit with a broken hook"
fi
[ "$(git -C "$RIG_TEST_REPO" rev-parse HEAD)" = "$successful_commit" ] || rig_test_fail "broken rig commit was not rolled back"

python3 -c 'import json,sys; state=json.load(open(sys.argv[1])); sys.exit(0 if any(pair["repo"] == sys.argv[2] for pair in state["badPairs"]) else 1)' \
	"$HOME/.agent-rig/state.json" "$broken_commit" || rig_test_fail "failed commit pair was not recorded"
first_run_count="$(wc -l < "$HOME/.agent-rig/broken-hook-runs")"
[ "$first_run_count" -ge 1 ] || rig_test_fail "broken hook did not run during the failed update"

rig update
second_run_count="$(wc -l < "$HOME/.agent-rig/broken-hook-runs")"
[ "$second_run_count" = "$first_run_count" ] || rig_test_fail "bad commit was retried"

git -C "$RIG_TEST_RIG_UPSTREAM" show "$successful_commit:base/hooks/project-tmp.sh" > "$hook"
rig_test_push_rig "fix after broken commit"
rig update
fixed_commit="$(git -C "$RIG_TEST_RIG_UPSTREAM" rev-parse HEAD)"
[ "$(git -C "$RIG_TEST_REPO" rev-parse HEAD)" = "$fixed_commit" ] || rig_test_fail "fix on top of the bad commit was not applied"
rig check
