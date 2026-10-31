#!/usr/bin/env bash
set -eu

: "${TEMP:?TEMP must point to the Docker test temp mount}"
run_directory="$(mktemp -d "$TEMP/agent-rig-docker-run.XXXXXX")"
trap 'rm -rf -- "$run_directory"' EXIT
passed=()
failed=()

# Optional first argument: the file-name prefix of the scenarios to run (`04` selects 04-*.sh). Empty runs all.
filter="${1:-}"
selected=()
for scenario in /workspace/tests/docker/[0-9][0-9]-*.sh; do
	name="${scenario##*/}"
	case "$name" in
		"$filter"*) selected+=("$scenario") ;;
	esac
done
if [ "${#selected[@]}" -eq 0 ]; then
	printf 'FAIL no scenario file starts with "%s" in tests/docker\n' "$filter" >&2
	exit 1
fi

for scenario in "${selected[@]}"; do
	name="${scenario##*/}"
	log="$run_directory/${name%.sh}.log"
	if bash "$scenario" > "$log" 2>&1; then
		passed+=("${name%.sh}")
		printf 'PASS %s\n' "${name%.sh}"
	else
		status="$?"
		failed+=("${name%.sh}")
		printf 'FAIL %s (exit %s)\n' "${name%.sh}" "$status"
		tail -n 60 "$log"
	fi
done

printf '\nPassed (%s):' "${#passed[@]}"
for name in "${passed[@]}"; do printf ' %s' "$name"; done
printf '\nFailed (%s):' "${#failed[@]}"
for name in "${failed[@]}"; do printf ' %s' "$name"; done
printf '\n'

[ "${#failed[@]}" -eq 0 ]
