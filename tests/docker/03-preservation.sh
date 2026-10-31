#!/usr/bin/env bash
set -eu

. /workspace/tests/docker/common.sh
rig_test_prepare
trap rig_test_cleanup EXIT
rig_test_install

settings="$HOME/.claude/settings.json"
expected="$RIG_TEST_ROOT/expected-setting.json"
python3 /workspace/tests/docker/settings-fixture.py seed "$settings" "$HOME/.agent-rig/state.json" "$expected"
printf '\nPersonal Claude text must survive.\n' >> "$HOME/.claude/CLAUDE.md"
printf '\nPersonal Codex text must survive.\n' >> "$HOME/.codex/AGENTS.md"

sed -i '\|^@../.agent-rig/generated/CLAUDE.md$|d' "$HOME/.claude/CLAUDE.md"
sed -i '/<!-- rig:end -->/iHuman note inside the damaged block must survive.' "$HOME/.codex/AGENTS.md"
sed -i 's/<!-- rig:end -->/<!-- rig:broken -->/' "$HOME/.codex/AGENTS.md"
rig apply

python3 /workspace/tests/docker/settings-fixture.py verify "$settings" "$HOME/.agent-rig/state.json" "$expected"
grep -Fxq '@../.agent-rig/generated/CLAUDE.md' "$HOME/.claude/CLAUDE.md" || rig_test_fail "removed Claude import was not restored"
grep -Fq 'Personal Claude text must survive.' "$HOME/.claude/CLAUDE.md" || rig_test_fail "foreign Claude text was lost"
grep -Fq 'Personal Codex text must survive.' "$HOME/.codex/AGENTS.md" || rig_test_fail "foreign Codex text was lost"
grep -Fq '<!-- rig:begin -->' "$HOME/.codex/AGENTS.md" || rig_test_fail "Codex begin marker was not repaired"
grep -Fq '<!-- rig:end -->' "$HOME/.codex/AGENTS.md" || rig_test_fail "Codex end marker was not repaired"
grep -Fq '<!-- rig:broken -->' "$HOME/.codex/AGENTS.md" || rig_test_fail "broken marker text was discarded"
grep -Fq 'Human note inside the damaged block must survive.' "$HOME/.codex/AGENTS.md" || rig_test_fail "text inside the damaged block was lost"

sed -i '\|^@../.agent-rig/generated/CLAUDE.md$|d' "$HOME/.claude/CLAUDE.md"
printf '\nUpdate preserves this Claude text too.\n' >> "$HOME/.claude/CLAUDE.md"
printf '\nUpdate preserves this Codex text too.\n' >> "$HOME/.codex/AGENTS.md"
printf '\nDocker scenario update marker.\n' >> "$RIG_TEST_RIG_UPSTREAM/README.md"
rig_test_push_rig "update preservation fixture"
rig update

python3 /workspace/tests/docker/settings-fixture.py verify "$settings" "$HOME/.agent-rig/state.json" "$expected"
grep -Fxq '@../.agent-rig/generated/CLAUDE.md' "$HOME/.claude/CLAUDE.md" || rig_test_fail "update did not restore the removed Claude import"
grep -Fq 'Update preserves this Claude text too.' "$HOME/.claude/CLAUDE.md" || rig_test_fail "update lost foreign Claude text"
grep -Fq 'Update preserves this Codex text too.' "$HOME/.codex/AGENTS.md" || rig_test_fail "update lost foreign Codex text"
grep -Fq '<!-- rig:broken -->' "$HOME/.codex/AGENTS.md" || rig_test_fail "update lost the repaired source text"
