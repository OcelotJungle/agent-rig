import type { PluginPlan, ProcessRunner } from "../../src/assets/installer";

import { describe, expect, test } from "bun:test";
import { applyPlugins } from "../../src/assets/installer";
import { messagesFor } from "../../src/messages";

const TEST_MESSAGES = messagesFor("en");
const SUCCESS_EXIT_CODE = 0;
const FAILURE_EXIT_CODE = 1;
const MARKETPLACE_LIST_JSON = "plugin marketplace list --json";
const UPDATE_COMMAND = "plugin update window@rig --scope user";
const CACHE_PATH = "C:/cfg/plugins/cache/rig/window/1.0.0";
const keepPath = async (path: string): Promise<string> => path;

const plan: readonly PluginPlan[] = [
  { enabled: true, id: "window@rig", marketplace: "rig", source: "C:/clone/plugins/window" },
];

type Facts = { version?: string; installPath?: string; folderVersion?: string };

// The text `claude plugin list --json` prints for one installed plugin (fields probed with claude 2.1.325).
function listing(facts: Facts): string {
  return JSON.stringify([{ id: "window@rig", scope: "user", ...facts }]);
}

function makeRunner(pluginList: string, failing: readonly string[] = []): ProcessRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const responses: Record<string, string> = {
    [MARKETPLACE_LIST_JSON]: JSON.stringify([{ name: "rig" }]),
    "plugin list --json": pluginList,
  };
  return {
    calls,
    async run(command, args) {
      calls.push([command, ...args]);
      const line = args.join(" ");
      if (failing.includes(line)) return { ok: true, value: { stdout: "", stderr: "boom", exitCode: FAILURE_EXIT_CODE } };
      return { ok: true, value: { stdout: responses[line] ?? "", stderr: "", exitCode: SUCCESS_EXIT_CODE } };
    },
  };
}

function changeCalls(runner: { calls: string[][] }): string[] {
  return runner.calls.map((call) => call.slice(1).join(" ")).filter((line) => !line.endsWith("list --json"));
}

describe("applyPlugins refreshes an installed plugin that differs from its source", () => {
  test("same version and an existing copy: no call, nothing updated", async () => {
    const runner = makeRunner(listing({ version: "1.0.0", folderVersion: "1.0.0", installPath: CACHE_PATH }));
    const result = await applyPlugins({ runner, claudeCommand: "claude", messages: TEST_MESSAGES, pathExists: async () => true, realPath: keepPath }, plan);
    expect(result.ok).toBe(true);
    expect(changeCalls(runner)).toEqual([]);
    if (result.ok) expect(result.value.updated).toEqual([]);
  });

  test("the source has another version: claude plugin update runs and the plugin is reported as updated", async () => {
    const runner = makeRunner(listing({ version: "1.0.0", folderVersion: "1.1.0", installPath: CACHE_PATH }));
    const result = await applyPlugins({ runner, claudeCommand: "claude", messages: TEST_MESSAGES, pathExists: async () => true, realPath: keepPath }, plan);
    expect(result.ok).toBe(true);
    expect(changeCalls(runner)).toEqual([UPDATE_COMMAND]);
    if (result.ok) {
      expect(result.value.updated).toEqual(["window@rig"]);
      expect(result.value.installed).toEqual([]);
    }
  });

  test("the installed copy is gone from disk: the plugin is installed again", async () => {
    const runner = makeRunner(listing({ version: "1.0.0", folderVersion: "1.0.0", installPath: CACHE_PATH }));
    const checked: string[] = [];
    const pathExists = async (path: string): Promise<boolean> => {
      checked.push(path);
      return false;
    };
    const result = await applyPlugins({ runner, claudeCommand: "claude", messages: TEST_MESSAGES, pathExists, realPath: keepPath }, plan);
    expect(result.ok).toBe(true);
    expect(checked).toEqual([CACHE_PATH]);
    expect(changeCalls(runner)).toEqual(["plugin install window@rig --scope user --yes"]);
    if (result.ok) expect(result.value.updated).toEqual(["window@rig"]);
  });

  test("a plugin without version facts (a remote source) is left alone while its copy exists", async () => {
    const runner = makeRunner(listing({ version: "abc123", installPath: CACHE_PATH }));
    const result = await applyPlugins({ runner, claudeCommand: "claude", messages: TEST_MESSAGES, pathExists: async () => true, realPath: keepPath }, plan);
    expect(result.ok).toBe(true);
    expect(changeCalls(runner)).toEqual([]);
  });

  test.each([
    ["update", UPDATE_COMMAND, { version: "1.0.0", folderVersion: "1.1.0", installPath: CACHE_PATH }, true],
    ["install", "plugin install window@rig --scope user --yes", { version: "1.0.0", folderVersion: "1.0.0", installPath: CACHE_PATH }, false],
  ])("a failing refresh step (%s) is an error, not swallowed", async (_name, failing, facts, copyExists) => {
    const runner = makeRunner(listing(facts), [failing]);
    const result = await applyPlugins({ runner, claudeCommand: "claude", messages: TEST_MESSAGES, pathExists: async () => copyExists, realPath: keepPath }, plan);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("boom");
  });
});
