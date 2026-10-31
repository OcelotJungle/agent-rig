#!/usr/bin/env bash
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="agent-rig-ubuntu-24.04-tests"
# Optional scenario filter: the file-name prefix of the scenarios to run, e.g. `04`. No argument runs all.
[ "$#" -le 1 ] || { printf 'usage: scripts/test-docker.sh [scenario-prefix]\n' >&2; exit 2; }
filter="${1:-}"
: "${TEMP:?TEMP must point to the project temp directory}"
# Git Bash rewrites /workspace-style arguments into Windows paths and breaks --workdir;
# docker must get the host path as Windows form (C:/...) and the container paths unchanged.
export MSYS_NO_PATHCONV=1
HOST_ROOT="$(cygpath -m "$ROOT" 2>/dev/null || printf '%s' "$ROOT")"

if ! docker build --quiet --tag "$IMAGE" --file "$HOST_ROOT/docker/ubuntu-24.04/Dockerfile" "$HOST_ROOT/docker"; then
	printf 'FAIL Docker image build\n' >&2
	exit 1
fi

if docker run --rm \
	--volume "$HOST_ROOT:/workspace:ro" \
	--volume "$TEMP:/test-temp" \
	--workdir /workspace \
	--env TEMP=/test-temp \
	"$IMAGE" bash -c 'set -eu; set -o pipefail; if ! command -v bun >/dev/null 2>&1; then curl -fsSL https://bun.com/install | bash; fi; export PATH="$HOME/.bun/bin:$PATH"; bash /workspace/tests/docker/run-all.sh "$1"' rig-test "$filter"; then
	exit 0
fi

printf 'FAIL Docker scenario runner\n' >&2
exit 1
