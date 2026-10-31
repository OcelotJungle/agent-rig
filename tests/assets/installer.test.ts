import type { AssetPlan, FileSystem, PluginPlan, ProcessRunner } from "../../src/assets/installer";

import { describe, expect, test } from "bun:test";
import { applyAssets, applyPlugins } from "../../src/assets/installer";

const DAY = "2026-10-30";
const LAST_CALL_INDEX = -1;
const EXPECTED_DIRECTORY_FILE_COUNT = 2;
const SUCCESS_EXIT_CODE = 0;

type TestFileSystem = FileSystem & { files: Map<string, string>; writes: string[] };

function makeFileSystem(initial: Readonly<Record<string, string>> = {}): TestFileSystem {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    files,
    writes,
    async readFile(path) {
      const value = files.get(path);
      return value === undefined
        ? { ok: false, error: "not-found" }
        : { ok: true, value: { bytes: new TextEncoder().encode(value), executable: false } };
    },
    async writeFileAtomic(path, content) {
      writes.push(path);
      files.set(path, new TextDecoder().decode(content.bytes));
      return { ok: true, value: undefined };
    },
    async realPath(path) {
      return { ok: true, value: path };
    },
    async removeFile(path) {
      files.delete(path);
      return { ok: true, value: undefined };
    },
    async listFiles(path) {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      return {
        ok: true,
        value: [...files.keys()].filter((file) => file.startsWith(prefix)),
      };
    },
    async makeDirectory() {
      return { ok: true, value: undefined };
    },
  };
}

function makeRunner(responses: Readonly<Record<string, string>> = {}): ProcessRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(command, args) {
      calls.push([command, ...args]);
      const response = responses[args.join(" ")] ?? "";
      return { ok: true, value: { stdout: response, stderr: "", exitCode: SUCCESS_EXIT_CODE } };
    },
  };
}

const assetPlan: AssetPlan = {
  enabled: true,
  clonePath: "C:/clone",
  homePath: "C:/Users/me",
  hubPath: "C:/Users/me/.agent-rig/hub",
  pythonPath: "python",
  files: [{ sourcePath: "C:/clone/features/skills/one", targetPath: "C:/Users/me/.claude/skills/one" }],
};

describe("applyAssets", () => {
  test("copies directories with placeholders and records a hash for every file", async () => {
    const fs = makeFileSystem({
      "C:/clone/features/skills/one/SKILL.md": "{{CLONE}} {{HUB}} {{PYTHON}} {{HOME}}",
      "C:/clone/features/skills/one/nested/run.py": "{{CLONE}}",
    });

    const result = await applyAssets({ fs, now: () => DAY }, [assetPlan], {});

    expect(result.ok).toBe(true);
    expect(fs.files.get("C:/Users/me/.claude/skills/one/SKILL.md")).toBe("C:/clone C:/Users/me/.agent-rig/hub python C:/Users/me");
    expect(result.ok && Object.keys(result.value.records).sort()).toEqual([
      "C:/Users/me/.claude/skills/one/SKILL.md",
      "C:/Users/me/.claude/skills/one/nested/run.py",
    ]);
    if (!result.ok) return;
    expect(fs.writes).toHaveLength(EXPECTED_DIRECTORY_FILE_COUNT);

    const repeated = await applyAssets({ fs, now: () => DAY }, [assetPlan], result.value.records);
    expect(repeated.ok).toBe(true);
    expect(fs.writes).toHaveLength(EXPECTED_DIRECTORY_FILE_COUNT);
    if (!repeated.ok) return;

    const removed = await applyAssets(
      { fs, now: () => DAY },
      [{ ...assetPlan, enabled: false }],
      repeated.value.records,
    );
    expect(removed.ok).toBe(true);
    expect(fs.files.has("C:/Users/me/.claude/skills/one/SKILL.md")).toBe(false);
    expect(fs.files.has("C:/Users/me/.claude/skills/one/nested/run.py")).toBe(false);
  });

  test("keeps a human edit and reports it only once, then restores a deleted managed file", async () => {
    const fs = makeFileSystem({ "C:/clone/features/skills/one/SKILL.md": "original" });
    const plan: AssetPlan = {
      ...assetPlan,
      files: [{ sourcePath: "C:/clone/features/skills/one/SKILL.md", targetPath: "C:/Users/me/.claude/skills/one/SKILL.md" }],
    };
    const first = await applyAssets({ fs, now: () => DAY }, [plan], {});
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    fs.files.set("C:/Users/me/.claude/skills/one/SKILL.md", "human edit");
    const kept = await applyAssets({ fs, now: () => DAY }, [plan], first.value.records);
    expect(kept.ok && kept.value.events).toEqual([
      { type: "setting-kept", path: "C:/Users/me/.claude/skills/one/SKILL.md" },
    ]);
    if (!kept.ok) return;
    const repeated = await applyAssets({ fs, now: () => DAY }, [plan], kept.value.records);
    expect(repeated.ok && repeated.value.events).toEqual([]);
    expect(fs.writes).toEqual(["C:/Users/me/.claude/skills/one/SKILL.md"]);

    fs.files.delete("C:/Users/me/.claude/skills/one/SKILL.md");
    const restored = await applyAssets({ fs, now: () => DAY }, [plan], repeated.ok ? repeated.value.records : {});
    expect(restored.ok && fs.files.get("C:/Users/me/.claude/skills/one/SKILL.md")).toBe("original");
  });

  test("adopts identical unowned files and removes disabled changed files to a dated backup", async () => {
    const target = "C:/Users/me/.claude/agents/guide.md";
    const source = "C:/clone/agents/guide.md";
    const fs = makeFileSystem({ [source]: "same", [target]: "same" });
    const plan: AssetPlan = { ...assetPlan, files: [{ sourcePath: source, targetPath: target }] };
    const adopted = await applyAssets({ fs, now: () => DAY }, [plan], {});
    expect(adopted.ok && adopted.value.records[target]).toBeDefined();
    if (!adopted.ok) return;

    fs.files.set(target, "edited");
    const disabled = await applyAssets(
      { fs, now: () => DAY },
      [{ ...plan, enabled: false }],
      adopted.value.records,
    );
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(fs.files.has(target)).toBe(false);
    expect(fs.files.get(`${target}.bak-${DAY}`)).toBe("edited");
    expect(disabled.value.events).toEqual([
      { type: "setting-kept", path: `${target}.bak-${DAY}` },
    ]);
  });

  test("names a backup without colons even when the clock gives a full ISO time (A7)", async () => {
    const target = "C:/Users/me/.claude/agents/guide.md";
    const source = "C:/clone/agents/guide.md";
    const fs = makeFileSystem({ [source]: "same", [target]: "same" });
    const plan: AssetPlan = { ...assetPlan, files: [{ sourcePath: source, targetPath: target }] };
    const adopted = await applyAssets({ fs, now: () => DAY }, [plan], {});
    if (!adopted.ok) throw new Error(adopted.error);
    fs.files.set(target, "edited");

    const disabled = await applyAssets({ fs, now: () => "2026-10-30T12:34:56.789Z" }, [{ ...plan, enabled: false }], adopted.value.records);

    expect(disabled.ok).toBe(true);
    expect(fs.files.get(`${target}.bak-${DAY}`)).toBe("edited");
    expect([...fs.files.keys()].filter((path) => path.slice("C:".length).includes(":"))).toEqual([]);
  });

  test("a second backup of another content on the same day gets its own number (A2)", async () => {
    const target = "C:/Users/me/.claude/agents/guide.md";
    const source = "C:/clone/agents/guide.md";
    const fs = makeFileSystem({ [source]: "same", [target]: "same", [`${target}.bak-${DAY}`]: "older backup" });
    const plan: AssetPlan = { ...assetPlan, files: [{ sourcePath: source, targetPath: target }] };
    const adopted = await applyAssets({ fs, now: () => DAY }, [plan], {});
    if (!adopted.ok) throw new Error(adopted.error);
    fs.files.set(target, "edited");

    const disabled = await applyAssets({ fs, now: () => DAY }, [{ ...plan, enabled: false }], adopted.value.records);

    expect(disabled.ok).toBe(true);
    expect(fs.files.get(`${target}.bak-${DAY}`)).toBe("older backup");
    expect(fs.files.get(`${target}.bak-${DAY}-2`)).toBe("edited");
  });

  test("removes records that no plan mentions any more like a disabled feature (A5)", async () => {
    const source = "C:/clone/agents/guide.md";
    const target = "C:/Users/me/.claude/agents/guide.md";
    const fs = makeFileSystem({ [source]: "guide" });
    const plan: AssetPlan = { ...assetPlan, files: [{ sourcePath: source, targetPath: target }] };
    const installed = await applyAssets({ fs, now: () => DAY }, [plan], {});
    if (!installed.ok) throw new Error(installed.error);

    const removed = await applyAssets({ fs, now: () => DAY }, [{ ...plan, files: [] }], installed.value.records);

    expect(removed.ok && removed.value.records).toEqual({});
    expect(fs.files.has(target)).toBe(false);
  });

  test("deletes unchanged managed files when the feature is disabled", async () => {
    const source = "C:/clone/agents/guide.md";
    const target = "C:/Users/me/.claude/agents/guide.md";
    const fs = makeFileSystem({ [source]: "guide" });
    const plan: AssetPlan = { ...assetPlan, files: [{ sourcePath: source, targetPath: target }] };
    const installed = await applyAssets({ fs, now: () => DAY }, [plan], {});
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;

    const removed = await applyAssets({ fs, now: () => DAY }, [{ ...plan, enabled: false }], installed.value.records);
    expect(removed.ok).toBe(true);
    expect(fs.files.has(target)).toBe(false);
  });
});

describe("applyAssets bytes (A8)", () => {
  test("a binary file and the exec bit of a script reach the target unchanged", async () => {
    const binary = new Uint8Array([0x89, 0x00, 0xff, 0xfe, 0xc3, 0x28]);
    const stored = new Map<string, { bytes: Uint8Array; executable: boolean }>([
      ["C:/clone/features/skills/one/logo.png", { bytes: binary, executable: false }],
      ["C:/clone/features/skills/one/run.sh", { bytes: new TextEncoder().encode("echo {{HOME}}"), executable: true }],
    ]);
    const base = makeFileSystem();
    const fs: FileSystem = {
      ...base,
      async readFile(path) {
        const content = stored.get(path);
        return content === undefined ? { ok: false, error: "not-found" } : { ok: true, value: content };
      },
      async writeFileAtomic(path, content) {
        stored.set(path, content);
        return { ok: true, value: undefined };
      },
      async listFiles(path) {
        return { ok: true, value: [...stored.keys()].filter((file) => file.startsWith(`${path}/`)) };
      },
    };

    const result = await applyAssets({ fs, now: () => DAY }, [assetPlan], {});

    expect(result.ok).toBe(true);
    expect(stored.get("C:/Users/me/.claude/skills/one/logo.png")?.bytes).toEqual(binary);
    expect(stored.get("C:/Users/me/.claude/skills/one/run.sh")?.executable).toBe(true);
    expect(new TextDecoder().decode(stored.get("C:/Users/me/.claude/skills/one/run.sh")?.bytes)).toBe("echo C:/Users/me");

    const repeated = await applyAssets({ fs, now: () => DAY }, [assetPlan], result.ok ? result.value.records : {});
    expect(repeated.ok && repeated.value.events).toEqual([]);
  });
});

describe("applyPlugins", () => {
  test("adds missing marketplaces and installs plugins, then does nothing on a second run", async () => {
    const plan: readonly PluginPlan[] = [
      { enabled: true, id: "codex@openai-codex", marketplace: "openai-codex", source: "openai/codex-plugin-cc" },
      { enabled: true, id: "superpowers@claude-plugins-official", marketplace: "claude-plugins-official", source: "anthropics/claude-plugins-official" },
      { enabled: true, id: "telegram-hub@telegram-hub-local", marketplace: "telegram-hub-local", source: "C:/hub/plugin" },
    ];
    const runner = makeRunner({
      "plugin marketplace list": "Configured marketplaces:\n  ❯ claude-plugins-official\n",
      "plugin list --json": "[]",
    });

    const first = await applyPlugins({ runner, claudeCommand: "claude" }, plan);
    expect(first.ok).toBe(true);
    expect(runner.calls).toEqual([
      ["claude", "plugin", "marketplace", "list"],
      ["claude", "plugin", "list", "--json"],
      ["claude", "plugin", "marketplace", "add", "openai/codex-plugin-cc"],
      ["claude", "plugin", "install", "codex@openai-codex", "--scope", "user", "--yes"],
      ["claude", "plugin", "install", "superpowers@claude-plugins-official", "--scope", "user", "--yes"],
      ["claude", "plugin", "marketplace", "add", "C:/hub/plugin"],
      ["claude", "plugin", "install", "telegram-hub@telegram-hub-local", "--scope", "user", "--yes"],
    ]);
    if (!first.ok) return;

    const secondRunner = makeRunner({
      "plugin marketplace list": "Configured marketplaces:\n  ❯ openai-codex\n  ❯ claude-plugins-official\n  ❯ telegram-hub-local\n",
      "plugin list --json": JSON.stringify(plan.map(({ id }) => ({ id }))),
    });
    const second = await applyPlugins({ runner: secondRunner, claudeCommand: "claude" }, plan, first.value.records);
    expect(second.ok).toBe(true);
    // The plugin list is always read (a hand-removed plugin must come back), but nothing is changed.
    expect(secondRunner.calls).toEqual([
      ["claude", "plugin", "marketplace", "list"],
      ["claude", "plugin", "list", "--json"],
    ]);
  });

  test("uninstalls a plugin when disabled", async () => {
    const runner = makeRunner({
      "plugin marketplace list": "",
      "plugin list --json": JSON.stringify([{ id: "codex@openai-codex" }]),
    });
    const result = await applyPlugins(
      { runner, claudeCommand: "claude" },
      [{ enabled: false, id: "codex@openai-codex", marketplace: "openai-codex", source: "openai/codex-plugin-cc" }],
    );
    expect(result.ok).toBe(true);
    expect(runner.calls.at(LAST_CALL_INDEX)).toEqual([
      "claude",
      "plugin",
      "uninstall",
      "codex@openai-codex",
      "--scope",
      "user",
      "--yes",
    ]);
  });

  test("adopts an already installed plugin without reinstalling it", async () => {
    const runner = makeRunner({
      "plugin marketplace list": "Configured marketplaces:\n  ❯ openai-codex\n",
      "plugin list --json": JSON.stringify([{ id: "codex@openai-codex" }]),
    });
    const result = await applyPlugins(
      { runner, claudeCommand: "claude" },
      [{ enabled: true, id: "codex@openai-codex", marketplace: "openai-codex", source: "openai/codex-plugin-cc" }],
    );
    expect(result.ok).toBe(true);
    expect(runner.calls).toEqual([
      ["claude", "plugin", "marketplace", "list"],
      ["claude", "plugin", "list", "--json"],
    ]);
  });
});
