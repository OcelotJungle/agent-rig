set -eu
set -o pipefail

RIG_TEST_ROOT=""
RIG_TEST_REPO=""
RIG_TEST_HUB=""
RIG_TEST_RIG_UPSTREAM=""
RIG_TEST_HUB_UPSTREAM=""

rig_test_fail() {
	printf 'FAIL: %s\n' "$*" >&2
	exit 1
}

rig_test_make_origin() {
	name="$1"
	source_path="$2"
	checkout_path="$3"
	seed_path="$RIG_TEST_ROOT/seed/$name"
	origin_path="$RIG_TEST_ROOT/origin/$name.git"
	upstream_path="$RIG_TEST_ROOT/upstream/$name"
	mkdir -p "$seed_path" "$(dirname "$checkout_path")" "$(dirname "$origin_path")" "$(dirname "$upstream_path")"
	tar -C "$source_path" \
		--exclude=.git \
		--exclude=./.git \
		--exclude='*/.git' \
		--exclude=.tmp \
		--exclude=./.tmp \
		--exclude='*/.tmp' \
		--exclude=node_modules \
		--exclude=./node_modules \
		--exclude='*/node_modules' \
		-cf - . | tar -C "$seed_path" -xf -
	git -C "$seed_path" init --initial-branch=main >/dev/null
	git -C "$seed_path" config user.name "Rig Docker Test"
	git -C "$seed_path" config user.email "rig-docker@example.invalid"
	git -C "$seed_path" add -A
	git -C "$seed_path" commit -m "initial $name fixture" >/dev/null
	git clone --bare "$seed_path" "$origin_path" >/dev/null
	git -C "$seed_path" remote add origin "$origin_path"
	git -C "$seed_path" push -u origin main >/dev/null
	git clone "$origin_path" "$checkout_path" >/dev/null
	git clone "$origin_path" "$upstream_path" >/dev/null
	git -C "$upstream_path" config user.name "Rig Docker Test"
	git -C "$upstream_path" config user.email "rig-docker@example.invalid"
}

rig_test_prepare() {
	: "${TEMP:?TEMP must point to the Docker test temp mount}"
	RIG_TEST_ROOT="$(mktemp -d "$TEMP/agent-rig-docker.XXXXXX")"
	HOME="$RIG_TEST_ROOT/home"
	export HOME
	PATH="$HOME/.local/bin:$HOME/.bun/bin:/opt/rig-fakes:$PATH"
	export PATH
	RIG_TEST_REPO="$HOME/.agent-rig/repo"
	RIG_TEST_HUB="$HOME/.agent-rig/hub"
	mkdir -p "$HOME/.agent-rig/fakes"
	printf 'active\n' > "$HOME/.agent-rig/fakes/telegram-hub.state"
	rig_test_make_origin rig /workspace "$RIG_TEST_REPO"
	rig_test_make_origin hub /workspace/docker/fake-hub "$RIG_TEST_HUB"
	RIG_TEST_RIG_UPSTREAM="$RIG_TEST_ROOT/upstream/rig"
	RIG_TEST_HUB_UPSTREAM="$RIG_TEST_ROOT/upstream/hub"
	[ -f "$RIG_TEST_REPO/base/feature.json" ] || rig_test_fail "base feature.json is missing from the merged source"
}

rig_test_cleanup() {
	if [ -z "$RIG_TEST_ROOT" ]; then return; fi
	case "$RIG_TEST_ROOT" in
		"$TEMP"/agent-rig-docker.*) rm -rf -- "$RIG_TEST_ROOT" ;;
		*) rig_test_fail "refusing to remove an unexpected temporary path: $RIG_TEST_ROOT" ;;
	esac
	RIG_TEST_ROOT=""
}

rig_test_install() {
	bun run "$RIG_TEST_REPO/src/cli.ts" install
}

rig_test_feature_flag() {
	python3 -c 'import json,sys; print(str(json.load(open(sys.argv[1]))["features"].get(sys.argv[2], False)).lower())' \
		"$HOME/.agent-rig/state.json" "$1"
}

rig_test_manifest_value() {
	python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])).get(sys.argv[2])))' "$1" "$2"
}

rig_test_hash_file() {
	if [ -f "$1" ]; then sha256sum "$1" | cut -c1-64; else printf 'missing\n'; fi
}

rig_test_snapshot() {
	{
		for directory in "$HOME/.claude" "$HOME/.codex" "$HOME/.agent-rig/generated" "$HOME/.agent-rig/fakes" "$HOME/.local/bin"; do
			if [ -d "$directory" ]; then find "$directory" -type f -print; fi
		done
		for file in "$HOME/.agent-rig/state.json" "$HOME/.agent-rig/events.jsonl" "$HOME/.agent-rig/fakes/crontab"; do
			if [ -f "$file" ]; then printf '%s\n' "$file"; fi
		done
	} | LC_ALL=C sort | while IFS= read -r file; do
		printf '%s ' "${file#"$HOME"/}"
		case "$file" in
			# Every apply reads the real plugin list on purpose; only calls that change something count.
			*/claude.calls|*/claude-plugin.calls) grep -Ev '^plugin (marketplace )?list' "$file" | sha256sum | cut -c1-64 ;;
			*) sha256sum "$file" | cut -c1-64 ;;
		esac
	done
}

rig_test_assert_apply_idempotent() {
	before="$(rig_test_snapshot)"
	rig apply
	after="$(rig_test_snapshot)"
	[ "$before" = "$after" ] || rig_test_fail "second apply changed file hashes"
}

rig_test_push_rig() {
	message="$1"
	git -C "$RIG_TEST_RIG_UPSTREAM" add -A
	git -C "$RIG_TEST_RIG_UPSTREAM" commit -m "$message" >/dev/null
	git -C "$RIG_TEST_RIG_UPSTREAM" push origin main >/dev/null
}

rig_test_push_hub() {
	message="$1"
	git -C "$RIG_TEST_HUB_UPSTREAM" add -A
	git -C "$RIG_TEST_HUB_UPSTREAM" commit -m "$message" >/dev/null
	git -C "$RIG_TEST_HUB_UPSTREAM" push origin main >/dev/null
}
