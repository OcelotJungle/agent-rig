import type { AssetPlan, AssetRecords, FileSystem } from "../../src/assets/installer";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyAssets } from "../../src/assets/installer";
import { createNodeAssetFileSystem } from "../../src/assets/node-asset-file-system";
import { hashContent } from "../../src/content-hash";

const DAY = "2026-10-30";
const TEMP_PREFIX = "rig-asset-paths-";
const CLONE = "C:/clone";
const HOME = "C:/Users/me";
const SKILL_SOURCE = "C:/clone/features/skills/one";
const SKILL_TARGET = "C:/Users/me/.claude/skills/one/SKILL.md";
const RULE_SOURCE = "C:/clone/base/RTK.md";
const RULE_TARGET = "C:/Users/me/.claude/RTK.md";
const BINARY_BYTES = new Uint8Array([0x00, 0x0d, 0x0a, 0xff, 0xfe, 0x0d, 0x0a]);

type MemoryFileSystem = FileSystem & { bytes: Map<string, Uint8Array>; writes: string[] };

// Files are stored under their forward-slash path. With `windowsListing` the listing comes back with backslashes, like
// the real adapter on Windows; every path argument is read in either form, like the Windows file system does.
const slash = (path: string): string => path.replaceAll("\\", "/");

function makeFileSystem(initial: Readonly<Record<string, string | Uint8Array>>, windowsListing: boolean): MemoryFileSystem {
  const bytes = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(initial)) {
    bytes.set(path, typeof value === "string" ? new TextEncoder().encode(value) : value);
  }
  const writes: string[] = [];
  return {
    bytes,
    writes,
    async readFile(path) {
      const value = bytes.get(slash(path));
      return value === undefined ? { ok: false, error: "not-found" } : { ok: true, value: { bytes: value, executable: false } };
    },
    async writeFileAtomic(path, content) {
      writes.push(slash(path));
      bytes.set(slash(path), content.bytes);
      return { ok: true, value: undefined };
    },
    async realPath(path) {
      return { ok: true, value: path };
    },
    async removeFile(path) {
      bytes.delete(slash(path));
      return { ok: true, value: undefined };
    },
    async listFiles(path) {
      const prefix = `${slash(path).replace(/\/+$/, "")}/`;
      const listed = [...bytes.keys()].filter((file) => file.startsWith(prefix));
      return { ok: true, value: windowsListing ? listed.map((file) => file.replaceAll("/", "\\")) : listed };
    },
    async makeDirectory() {
      return { ok: true, value: undefined };
    },
  };
}

const plan = (files: AssetPlan["files"]): AssetPlan => ({
  enabled: true,
  clonePath: CLONE,
  homePath: HOME,
  hubPath: "C:/hub",
  pythonPath: "python",
  files,
});

const textHash = (text: string): string => hashContent({ bytes: new TextEncoder().encode(text), executable: false });

describe("asset paths have one form: forward slashes", () => {
  test("a directory listing with backslashes (Windows) is read and the targets and record keys use forward slashes", async () => {
    const fs = makeFileSystem({ [`${SKILL_SOURCE}/SKILL.md`]: "skill", [`${SKILL_SOURCE}/nested/run.py`]: "run" }, true);

    const result = await applyAssets({ fs, now: () => DAY }, [plan([{ sourcePath: SKILL_SOURCE, targetPath: "C:/Users/me/.claude/skills/one" }])], {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.records).sort()).toEqual([SKILL_TARGET, "C:/Users/me/.claude/skills/one/nested/run.py"]);
    expect(fs.writes.sort()).toEqual([SKILL_TARGET, "C:/Users/me/.claude/skills/one/nested/run.py"]);
  });

  test("a target given with backslashes gets forward-slash keys and writes", async () => {
    const fs = makeFileSystem({ [`${SKILL_SOURCE}/SKILL.md`]: "skill" }, true);

    const result = await applyAssets({ fs, now: () => DAY }, [plan([{ sourcePath: SKILL_SOURCE, targetPath: "C:\\Users\\me\\.claude\\skills\\one" }])], {});

    expect(result.ok && Object.keys(result.value.records)).toEqual([SKILL_TARGET]);
  });

  test("records written by the previous build with backslash keys still match: no duplicate, no foreign file, no rewrite", async () => {
    const fs = makeFileSystem({ [`${SKILL_SOURCE}/SKILL.md`]: "skill", [SKILL_TARGET]: "skill" }, true);
    const oldKey = "C:\\Users\\me\\.claude\\skills\\one\\SKILL.md";
    const prior: AssetRecords = { [oldKey]: { hash: textHash("skill"), owned: true, notifiedHashes: [] } };

    const result = await applyAssets({ fs, now: () => DAY }, [plan([{ sourcePath: SKILL_SOURCE, targetPath: "C:/Users/me/.claude/skills/one" }])], prior);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value.records)).toEqual([SKILL_TARGET]);
    expect(result.value.records[SKILL_TARGET]?.owned).toBe(true);
    expect(result.value.events).toEqual([]);
    expect(fs.writes).toEqual([]);
  });

  test("an old backslash record of a disabled feature is still removed", async () => {
    const fs = makeFileSystem({ [SKILL_TARGET]: "skill" }, true);
    const oldKey = "C:\\Users\\me\\.claude\\skills\\one\\SKILL.md";
    const prior: AssetRecords = { [oldKey]: { hash: textHash("skill"), owned: true, notifiedHashes: [] } };

    const result = await applyAssets({ fs, now: () => DAY }, [{ ...plan([{ sourcePath: SKILL_SOURCE, targetPath: "C:/Users/me/.claude/skills/one" }]), enabled: false }], prior);

    expect(result.ok && result.value.records).toEqual({});
    expect(fs.bytes.has(SKILL_TARGET)).toBe(false);
  });

  test("placeholders render with forward slashes even when the paths are given with backslashes", async () => {
    const fs = makeFileSystem({ [RULE_SOURCE]: "{{HOME}}|{{CLONE}}|{{HUB}}" }, false);
    const windowsPlan: AssetPlan = { ...plan([{ sourcePath: RULE_SOURCE, targetPath: RULE_TARGET }]), homePath: "C:\\Users\\me", clonePath: "C:\\clone", hubPath: "C:\\hub" };

    const result = await applyAssets({ fs, now: () => DAY }, [windowsPlan], {});

    expect(result.ok).toBe(true);
    expect(new TextDecoder().decode(fs.bytes.get(RULE_TARGET))).toBe("C:/Users/me|C:/clone|C:/hub");
  });
});

describe("line endings do not make a text file foreign", () => {
  test("a live text file that differs only by CRLF is accepted as rig's own, not reported and not rewritten", async () => {
    const fs = makeFileSystem({ [RULE_SOURCE]: "one\ntwo\n", [RULE_TARGET]: "one\r\ntwo\r\n" }, false);

    const result = await applyAssets({ fs, now: () => DAY }, [plan([{ sourcePath: RULE_SOURCE, targetPath: RULE_TARGET }])], {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.events).toEqual([]);
    expect(result.value.records[RULE_TARGET]?.owned).toBe(true);
    expect(fs.writes).toEqual([]);
    const again = await applyAssets({ fs, now: () => DAY }, [plan([{ sourcePath: RULE_SOURCE, targetPath: RULE_TARGET }])], result.value.records);
    expect(again.ok && again.value.events).toEqual([]);
    expect(fs.writes).toEqual([]);
  });

  test("a file rig owns that is later saved with CRLF stays rig's own with no event", async () => {
    const fs = makeFileSystem({ [RULE_SOURCE]: "one\ntwo\n", [RULE_TARGET]: "one\r\ntwo\r\n" }, false);
    const owned: AssetRecords = { [RULE_TARGET]: { hash: hashContent({ bytes: new TextEncoder().encode("one\ntwo\n"), executable: false }), owned: true, notifiedHashes: [] } };

    const result = await applyAssets({ fs, now: () => DAY }, [plan([{ sourcePath: RULE_SOURCE, targetPath: RULE_TARGET }])], owned);

    expect(result.ok && result.value.events).toEqual([]);
    expect(result.ok && result.value.records[RULE_TARGET]?.owned).toBe(true);
    expect(fs.writes).toEqual([]);
  });

  test("a record the old build left as foreign only because of CRLF becomes rig's own", async () => {
    const fs = makeFileSystem({ [RULE_SOURCE]: "one\ntwo\n", [RULE_TARGET]: "one\r\ntwo\r\n" }, false);
    const crlfHash = hashContent({ bytes: new TextEncoder().encode("one\r\ntwo\r\n"), executable: false });
    const foreign: AssetRecords = { [RULE_TARGET]: { hash: crlfHash, owned: false, notifiedHashes: [crlfHash] } };

    const result = await applyAssets({ fs, now: () => DAY }, [plan([{ sourcePath: RULE_SOURCE, targetPath: RULE_TARGET }])], foreign);

    expect(result.ok && result.value.events).toEqual([]);
    expect(result.ok && result.value.records[RULE_TARGET]?.owned).toBe(true);
    expect(fs.writes).toEqual([]);
  });

  test("a real text difference is still foreign", async () => {
    const fs = makeFileSystem({ [RULE_SOURCE]: "one\ntwo\n", [RULE_TARGET]: "one\r\nthree\r\n" }, false);

    const result = await applyAssets({ fs, now: () => DAY }, [plan([{ sourcePath: RULE_SOURCE, targetPath: RULE_TARGET }])], {});

    expect(result.ok && result.value.events).toEqual([{ type: "setting-kept", path: RULE_TARGET }]);
  });

  test("a binary file is compared byte for byte: CRLF bytes are a difference", async () => {
    const lineFeedOnly = new Uint8Array([0x00, 0x0a, 0xff, 0xfe, 0x0a]);
    const fs = makeFileSystem({ [RULE_SOURCE]: lineFeedOnly, [RULE_TARGET]: BINARY_BYTES }, false);

    const result = await applyAssets({ fs, now: () => DAY }, [plan([{ sourcePath: RULE_SOURCE, targetPath: RULE_TARGET }])], {});

    expect(result.ok && result.value.events).toEqual([{ type: "setting-kept", path: RULE_TARGET }]);
  });
});

describe("the real adapter on this machine", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a skill directory given with forward slashes (as git reports the clone) is installed", async () => {
    const source = join(root, "clone", "skills", "one");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), "skill");
    await writeFile(join(source, "nested", "run.sh"), "run");
    const forward = (path: string): string => path.replaceAll("\\", "/");
    const target = forward(join(root, "home", ".claude", "skills", "one"));

    const result = await applyAssets(
      { fs: createNodeAssetFileSystem(), now: () => DAY },
      [{ ...plan([{ sourcePath: forward(source), targetPath: target }]), clonePath: forward(join(root, "clone")), homePath: forward(join(root, "home")) }],
      {},
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await readFile(join(root, "home", ".claude", "skills", "one", "nested", "run.sh"), "utf8")).toBe("run");
    expect(Object.keys(result.value.records).sort()).toEqual([`${target}/SKILL.md`, `${target}/nested/run.sh`]);
  });

  test("listFiles returns forward-slash paths", async () => {
    await mkdir(join(root, "dir", "nested"), { recursive: true });
    await writeFile(join(root, "dir", "nested", "a.txt"), "a");

    const listed = await createNodeAssetFileSystem().listFiles(join(root, "dir"));

    expect(listed.ok && listed.value).toEqual([`${join(root, "dir").replaceAll("\\", "/")}/nested/a.txt`]);
  });
});
