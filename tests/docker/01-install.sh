#!/usr/bin/env bash
set -eu

. /workspace/tests/docker/common.sh
rig_test_prepare
trap rig_test_cleanup EXIT

[ "$(id -u)" -ne 0 ] || rig_test_fail "Docker scenarios must run as a non-root user"
[ ! -e "$HOME/.claude/settings.json" ] || rig_test_fail "test home was not empty before install"

rig_test_install
rig check

[ -x "$HOME/.local/bin/rig" ] || rig_test_fail "rig shim was not installed"
[ -f "$HOME/.agent-rig/fakes/crontab" ] || rig_test_fail "server cron entries were not installed"
[ ! -e "$HOME/.agent-rig/rig.lock" ] || rig_test_fail "install left a rig lock behind"
