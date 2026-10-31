#!/usr/bin/env bash
set -eu

. /workspace/tests/docker/common.sh
rig_test_prepare
trap rig_test_cleanup EXIT

# Two behaviours that only run on POSIX: killTree kills the whole process group, and a cancelled
# Codex job starts in its own session so its children die with it. Windows skips the Python class
# and never reaches the POSIX branch of killTree, so only this Linux scenario exercises them.
cd /workspace
# The whole bun suite runs here, so the Windows planSpawn cases run on Linux too.
bun_log="$RIG_TEST_ROOT/bun-test.log"
if ! bun test > "$bun_log" 2>&1; then
	cat "$bun_log" >&2
	rig_test_fail "bun test failed in the Ubuntu container"
fi
# bun test exits 0 when it finds no tests, so the run must report at least one passing test.
if ! grep -Eq '^ [1-9][0-9]* pass$' "$bun_log"; then
	cat "$bun_log" >&2
	rig_test_fail "bun test reported no passing tests"
fi

codex_log="$RIG_TEST_ROOT/codex-run-tests.log"
if ! python3 -I -B -m unittest discover -v -s /workspace/features/codex/tools/tests -p 'test_codex_run.py' > "$codex_log" 2>&1; then
	cat "$codex_log" >&2
	rig_test_fail "features/codex/tools/tests/test_codex_run.py failed"
fi
# unittest exits 0 when a test is skipped: a skip turns the summary into "OK (skipped=N)", so a plain "OK"
# line with the test's own id in the log means that test ran and was not skipped.
if ! grep -Fq 'CancelStopsJobChildrenTest.test_cancel_stops_the_children_of_the_job)' "$codex_log" || ! grep -Eq '^OK$' "$codex_log"; then
	cat "$codex_log" >&2
	rig_test_fail "CancelStopsJobChildrenTest.test_cancel_stops_the_children_of_the_job was skipped or missing"
fi
