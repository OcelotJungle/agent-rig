#!/usr/bin/env bash
set -eu

. /workspace/tests/docker/common.sh
rig_test_prepare
trap rig_test_cleanup EXIT

# Behaviours that only run on Linux, so only this scenario exercises them: the process-job reaper
# (PR_SET_CHILD_SUBREAPER) must clean up processes that escaped into their own session, and the four
# reaper tests must run, not be skipped; killTree kills the whole process group in the bun suite; a
# cancelled Codex job leaves no children behind. Windows skips these POSIX branches.
cd /workspace
process_job_log="$RIG_TEST_ROOT/process-job-tests.log"
if ! python3 -I -B -m unittest discover -v -s /workspace/base/tools/tests -p 'test_process_job.py' > "$process_job_log" 2>&1; then
	cat "$process_job_log" >&2
	rig_test_fail "base/tools/tests/test_process_job.py failed"
fi
# The reaper tests are skipped unless Linux subreaper support is available, and a skip keeps the exit code 0.
# Each must show "... ok" in the verbose log (a skip prints "... skipped"). The summary is "OK (skipped=2)"
# because the two Windows-only tests always skip on Linux, so it cannot be required to be a plain "OK".
for reaper_test in test_close_cleans_session_escape_while_command_runs test_command_exit_status_passes_through \
	test_owner_sigkill_cleans_session_escape test_reaper_cleans_session_escape_before_wait_returns; do
	if ! grep -Eq "^${reaper_test} \(.*\) \.\.\. ok$" "$process_job_log"; then
		cat "$process_job_log" >&2
		rig_test_fail "process-job reaper test $reaper_test was skipped, failed or missing"
	fi
done
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
# unittest exits 0 when a test is skipped, and the summary is "OK (skipped=1)" because the live Codex probe
# always skips here, so the test's own line must end with "... ok" (a skip prints "... skipped").
if ! grep -Eq 'CancelStopsJobChildrenTest\.test_cancel_stops_the_children_of_the_job\) \.\.\. ok$' "$codex_log"; then
	cat "$codex_log" >&2
	rig_test_fail "CancelStopsJobChildrenTest.test_cancel_stops_the_children_of_the_job was skipped or missing"
fi
