#!/usr/bin/env python3
"""Print feature names in dependency order for a Docker scenario."""
import json
import sys
from pathlib import Path

repo = Path(sys.argv[1])
platform = sys.argv[2]
features = {}
for manifest_path in sorted((repo / "features").glob("*/feature.json")):
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if platform == "all" or platform in manifest["platforms"]:
        features[manifest["name"]] = manifest

ordered = []
pending = set(features)
while pending:
    ready = sorted(
        name
        for name in pending
        if all(dependency in ordered for dependency in features[name]["dependencies"])
    )
    if not ready:
        sys.stderr.write(f"Cannot order feature dependencies for {platform}: {', '.join(sorted(pending))}\n")
        raise SystemExit(1)
    ordered.extend(ready)
    pending.difference_update(ready)

for name in ordered:
    print(name)
