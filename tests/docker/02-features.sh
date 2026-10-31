#!/usr/bin/env bash
set -eu

. /workspace/tests/docker/common.sh
rig_test_prepare
trap rig_test_cleanup EXIT
rig_test_install

feature_order="$(python3 /workspace/tests/docker/feature-order.py "$RIG_TEST_REPO" linux)"
for feature in $feature_order; do
	rig feature "$feature" enable
done

enabled_rules="$(cat "$HOME/.codex/AGENTS.md" "$HOME/.agent-rig/generated/CLAUDE.md" | sha256sum | cut -c1-64)"
enabled_settings="$(rig_test_hash_file "$HOME/.claude/settings.json")"
enabled_plugins="$(rig_test_hash_file "$HOME/.agent-rig/fakes/claude-plugins")"

reverse_order="$(python3 /workspace/tests/docker/feature-order.py "$RIG_TEST_REPO" linux | tac)"
for feature in $reverse_order; do
	rig feature "$feature" disable
	[ "$(rig_test_feature_flag "$feature")" = "false" ] || rig_test_fail "feature $feature stayed enabled after disable"
	rig_test_assert_apply_idempotent
done

disabled_rules="$(cat "$HOME/.codex/AGENTS.md" "$HOME/.agent-rig/generated/CLAUDE.md" | sha256sum | cut -c1-64)"
disabled_settings="$(rig_test_hash_file "$HOME/.claude/settings.json")"
disabled_plugins="$(rig_test_hash_file "$HOME/.agent-rig/fakes/claude-plugins")"
[ "$enabled_rules" != "$disabled_rules" ] || rig_test_fail "disabling all Linux features did not change rules"
[ "$enabled_settings" != "$disabled_settings" ] || rig_test_fail "disabling all Linux features did not change hooks or settings"
[ "$enabled_plugins" != "$disabled_plugins" ] || rig_test_fail "disabling all Linux features did not change plugins"

for feature in $feature_order; do
	rig feature "$feature" enable
	[ "$(rig_test_feature_flag "$feature")" = "true" ] || rig_test_fail "feature $feature stayed disabled after enable"
	rig_test_assert_apply_idempotent
done

for manifest in "$RIG_TEST_REPO"/features/*/feature.json; do
	if python3 -c 'import json,sys; sys.exit(0 if "linux" in json.load(open(sys.argv[1]))["platforms"] else 1)' "$manifest"; then
		continue
	fi
	feature="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$manifest")"
	if rig feature "$feature" enable > "$RIG_TEST_ROOT/platform-error.log" 2>&1; then
		rig_test_fail "Windows-only feature $feature enabled on Linux"
	fi
	grep -qi "only on Windows" "$RIG_TEST_ROOT/platform-error.log" || rig_test_fail "feature $feature did not explain its Linux platform refusal"
	[ "$(rig_test_feature_flag "$feature")" = "false" ] || rig_test_fail "failed enable changed state for $feature"
done
