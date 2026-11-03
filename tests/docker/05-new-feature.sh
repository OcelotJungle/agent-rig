#!/usr/bin/env bash
set -eu

. /workspace/tests/docker/common.sh
rig_test_prepare
trap rig_test_cleanup EXIT
rig_test_install
cp "$HOME/.agent-rig/state.json" "$RIG_TEST_ROOT/state-before.json"

new_feature="$RIG_TEST_RIG_UPSTREAM/features/docker-new/feature.json"
mkdir -p "$(dirname "$new_feature")"
printf '%s\n' '{"name":"docker-new","description":"Docker update fixture","translations":{"ru":{"description":"Docker update fixture (ru)"}},"enabledByDefault":true,"platforms":["linux"],"dependencies":[],"rules":[],"hooks":[],"settings":[],"plugins":[],"files":[],"agents":[],"skills":[],"hubCommands":[],"programs":[]}' > "$new_feature"
rig_test_push_rig "new feature fixture"
rig update

python3 -c 'import json,sys; before=json.load(open(sys.argv[1]))["features"]; after=json.load(open(sys.argv[2]))["features"]; sys.exit(0 if all(after.get(name) == enabled for name,enabled in before.items()) and after.get("docker-new") is False else 1)' \
	"$RIG_TEST_ROOT/state-before.json" "$HOME/.agent-rig/state.json" || rig_test_fail "new feature was not disabled or an existing feature changed state"
grep -Fq 'The new feature \"docker-new\" is disabled. Enable it: rig feature docker-new enable' "$HOME/.agent-rig/events.jsonl" || rig_test_fail "new feature event omitted the enable command"
