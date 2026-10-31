import type { DesiredSettingEntry, ListEntryOwnershipRecord, SettingsMergeRequest, SettingsOwnershipRecord } from "../../src/settings/merge-settings";

import { describe, expect, it } from "bun:test";
import { mergeSettings } from "../../src/settings/merge-settings";

const AUTO_MODE_ENTRY_INDEX = 1;

const request = (
  currentText: string,
  desiredEntries: readonly DesiredSettingEntry[],
  ownershipRecords: readonly SettingsOwnershipRecord[] = [],
  mode: SettingsMergeRequest["mode"] = "apply",
): SettingsMergeRequest => ({
  currentText,
  desiredEntries,
  ownershipRecords,
  mode,
  backupPath: "settings.json.bak-2026-10-30",
});

const permission = (value = "Bash(python tools/codex-run.py)"): DesiredSettingEntry => ({
  id: "codex-allow-python",
  feature: "codex",
  kind: "list-entry",
  path: ["permissions", "allow"],
  value,
});

const permissionRecord = (value = "Bash(python tools/codex-run.py)"): ListEntryOwnershipRecord => ({
  id: "codex-allow-python",
  feature: "codex",
  kind: "list-entry",
  path: ["permissions", "allow"],
  value,
  index: 1,
  arrayLength: 2,
  beforeValue: "Read",
});

describe("mergeSettings", () => {
  it("adds a missing owned list value while preserving foreign values, order, and formatting", () => {
    const current = [
      "{",
      "  \"permissions\": { \"deny\": [\"Bash(rm -rf)\"], \"allow\": [\"Read\"] },",
      "  \"theme\": \"dark\"",
      "}",
    ].join("\n");
    const result = mergeSettings(request(current, [permission()]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("\"deny\": [\"Bash(rm -rf)\"]");
    expect(result.text).toContain("\"allow\": [\"Read\",\"Bash(python tools/codex-run.py)\"]");
    expect(result.text.indexOf("\"deny\"")).toBeLessThan(result.text.indexOf("\"allow\""));
    expect(result.text).toContain("\"theme\": \"dark\"");
    expect(result.records).toHaveLength(1);
  });

  it("adopts an exact existing value without rewriting the text", () => {
    const current = "{ \"permissions\": { \"allow\": [\"Read\", \"Bash(python tools/codex-run.py)\"] } }";
    const result = mergeSettings(request(current, [permission()]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(current);
    expect(result.changed).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.records).toHaveLength(1);
  });

  it("keeps an edited value and emits setting-kept once per distinct change", () => {
    const current = "{\n  \"permissions\": {\n    \"allow\": [\"Read\", \"Bash(python custom.py)\"]\n  }\n}";
    const desired = [permission()];
    const first = mergeSettings(request(current, desired, [permissionRecord()]));

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.text).toBe(current);
    expect(first.events).toHaveLength(1);
    expect(first.events[0]?.type).toBe("setting-kept");
    const second = mergeSettings(request(current, desired, first.records));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.events).toEqual([]);

    const next = mergeSettings(request(current.replace("custom.py", "custom-two.py"), desired, second.records));
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.events).toHaveLength(1);
  });

  it("restores an owned value deleted while its feature remains enabled", () => {
    const result = mergeSettings(request("{ \"permissions\": { \"allow\": [\"Read\"] } }", [permission()], [permissionRecord()]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("Bash(python tools/codex-run.py)");
    expect(result.records).toHaveLength(1);
  });

  it("removes an unchanged value when its feature is disabled", () => {
    const current = "{ \"permissions\": { \"allow\": [\"Read\", \"Bash(python tools/codex-run.py)\"] } }";
    const result = mergeSettings(request(current, [], [permissionRecord()]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("{ \"permissions\": { \"allow\": [\"Read\"] } }");
    expect(result.records).toEqual([]);
    expect(result.backupValues).toEqual([]);
  });

  it("removes a changed value on disable and returns its value for the backup", () => {
    const record = permissionRecord();
    const current = "{ \"permissions\": { \"allow\": [\"Read\", \"Bash(python custom.py)\"] } }";
    const result = mergeSettings(request(current, [], [record]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("{ \"permissions\": { \"allow\": [\"Read\"] } }");
    expect(result.records).toEqual([]);
    expect(result.backupValues).toEqual([
      { id: record.id, location: record.path, value: "Bash(python custom.py)" },
    ]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.text).toContain("settings.json.bak-2026-10-30");
  });

  it("owns env keys individually and leaves unrelated env and permissions untouched", () => {
    const current = "{\n  \"env\": {\n    \"OTHER\": \"keep\"\n  },\n  \"permissions\": {\n    \"allow\": [\"Read\"]\n  }\n}";
    const desired: DesiredSettingEntry[] = [
      { id: "base-powershell-env", feature: "base", kind: "value", path: ["env", "CLAUDE_CODE_USE_POWERSHELL_TOOL"], value: "0" },
      permission(),
    ];
    const result = mergeSettings(request(current, desired));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("\"OTHER\": \"keep\"");
    expect(result.text).toContain("\"CLAUDE_CODE_USE_POWERSHELL_TOOL\": \"0\"");
    expect(result.text).toContain("\"allow\": [\"Read\",\"Bash(python tools/codex-run.py)\"]");
  });



  it("owns marketplace and plugin keys without replacing foreign entries", () => {
    const current = "{\n  \"extraKnownMarketplaces\": { \"foreign\": { \"source\": \"github\" } },\n  \"enabledPlugins\": { \"human@store\": true }\n}";
    const desired: DesiredSettingEntry[] = [
      {
        id: "superpowers-marketplace",
        feature: "superpowers",
        kind: "value",
        path: ["extraKnownMarketplaces", "superpowers"],
        value: { source: "github", repo: "anthropics/claude-plugins-official" },
      },
      {
        id: "codex-plugin",
        feature: "codex",
        kind: "value",
        path: ["enabledPlugins", "codex@openai-codex"],
        value: true,
      },
    ];
    const result = mergeSettings(request(current, desired));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("\"foreign\": { \"source\": \"github\" }");
    expect(result.text).toContain("\"human@store\": true");
    expect(result.text).toContain("\"superpowers\":");
    expect(result.text).toContain("\"codex@openai-codex\": true");
    expect(result.records).toHaveLength(2);
  });

  it("tracks an env key independently and backs up its human edit on disable", () => {
    const current = "{ \"env\": { \"RIG_KEY\": \"custom\", \"OTHER\": \"keep\" } }";
    const record: SettingsOwnershipRecord = {
      id: "base-env-key",
      feature: "base",
      kind: "value",
      path: ["env", "RIG_KEY"],
      value: "managed",
    };
    const desired: DesiredSettingEntry = {
      id: "base-env-key",
      feature: "base",
      kind: "value",
      path: ["env", "RIG_KEY"],
      value: "managed",
    };
    const first = mergeSettings(request(current, [desired], [record]));

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.text).toBe(current);
    expect(first.events).toHaveLength(1);
    const disabled = mergeSettings(request(current, [], first.records));
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.text).not.toContain("RIG_KEY");
    expect(disabled.text).toContain("OTHER");
    expect(disabled.backupValues).toEqual([
      { id: "base-env-key", location: ["env", "RIG_KEY"], value: "custom" },
    ]);
  });

  it("leaves a value the rig does not own untouched even when the desired value differs", () => {
    const current = "{ \"env\": { \"RIG_KEY\": \"custom\" } }";
    const record: SettingsOwnershipRecord = {
      id: "base-env-key",
      feature: "base",
      kind: "value",
      path: ["env", "RIG_KEY"],
      value: "custom",
      owned: false,
    };
    const desired: DesiredSettingEntry = {
      id: "base-env-key",
      feature: "base",
      kind: "value",
      path: ["env", "RIG_KEY"],
      value: "managed",
    };
    const result = mergeSettings(request(current, [desired], [record]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(current);
    expect(result.changed).toBe(false);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe("setting-kept");
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.owned).toBe(false);
  });

  it("produces identical text and no write on a second unchanged pass", () => {
    const first = mergeSettings(request("{ \"permissions\": { \"allow\": [\"Read\"] } }", [permission()]));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = mergeSettings(request(first.text, [permission()], first.records));

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.text).toBe(first.text);
    expect(second.changed).toBe(false);
    expect(second.events).toEqual([]);
  });

  it("fails without replacement text when current settings do not parse", () => {
    const result = mergeSettings(request("{\n  \"permissions\": [\n}", [permission()]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("JSON");
  });

  it("preserves a list key that became a non-list and remembers the change", () => {
    const current = "{ \"permissions\": { \"allow\": \"human value\" } }";
    const desired = [permission()];
    const first = mergeSettings(request(current, desired, [permissionRecord()]));

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.text).toBe(current);
    expect(first.events).toHaveLength(1);
    const second = mergeSettings(request(current, desired, first.records));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.events).toEqual([]);
  });

  it("removes stale records for a feature that no longer exists", () => {
    const oldRecord: SettingsOwnershipRecord = {
      id: "removed-feature-key",
      feature: "removed-feature",
      kind: "value",
      path: ["env", "OLD_FEATURE_KEY"],
      value: "managed",
    };
    const result = mergeSettings(request("{ \"env\": { \"OLD_FEATURE_KEY\": \"managed\" }, \"theme\": \"dark\" }", [], [oldRecord]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain("OLD_FEATURE_KEY");
    expect(result.text).toContain("\"theme\": \"dark\"");
    expect(result.records).toEqual([]);
  });

  it("writes the update channel only during install, only when absent, and never owns it", () => {
    const channel: DesiredSettingEntry = {
      id: "rig-update-channel",
      kind: "install-default",
      path: ["autoUpdatesChannel"],
      value: "stable",
    };
    const apply = mergeSettings(request("{}", [channel]));
    expect(apply.ok).toBe(true);
    if (!apply.ok) return;
    expect(apply.text).toBe("{}");
    expect(apply.records).toEqual([]);

    const install = mergeSettings(request("{}", [channel], [], "install"));
    expect(install.ok).toBe(true);
    if (!install.ok) return;
    expect(install.text).toContain("\"autoUpdatesChannel\": \"stable\"");
    expect(install.records).toEqual([]);

    const existing = mergeSettings(request("{ \"autoUpdatesChannel\": \"latest\" }", [channel], [], "install"));
    expect(existing.ok).toBe(true);
    if (!existing.ok) return;
    expect(existing.text).toBe("{ \"autoUpdatesChannel\": \"latest\" }");
  });

  it("adopts a hook by script identity across path and interpreter without rewriting", () => {
    const current = [
      "{",
      "  \"hooks\": {",
      "    \"Stop\": [{ \"matcher\": \"\", \"hooks\": [{ \"type\": \"command\", \"command\": \"py\", \"args\": [\"-3\", \"C:/Users/x/.claude/hooks/reflect.py\"] }] }]",
      "  }",
      "}",
    ].join("\n");
    const desired: DesiredSettingEntry = {
      id: "reflection-stop",
      feature: "reflection",
      kind: "hook",
      event: "Stop",
      matcher: "",
      scriptName: "reflect.py",
      value: { type: "command", command: "python", args: ["/home/user/repo/hooks/reflect.py"] },
    };
    const result = mergeSettings(request(current, [desired]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(current);
    expect(result.records).toHaveLength(1);
    expect(result.events).toEqual([]);
  });

  it("recognizes script names in command strings and the rtk hook command", () => {
    const current = "{\"hooks\":{\"PreToolUse\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"python \\\"C:/Users/x/.claude/hooks/no_ampersand.py\\\"\"}]}],\"UserPromptSubmit\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"command\",\"command\":\"rtk hook claude\"}]}]}}";
    const desired: DesiredSettingEntry[] = [
      {
        id: "base-no-ampersand",
        feature: "base",
        kind: "hook",
        event: "PreToolUse",
        matcher: "Bash",
        scriptName: "no_ampersand.py",
        value: { type: "command", command: "python", args: ["/repo/hooks/no_ampersand.py"] },
      },
      {
        id: "rtk-pretooluse",
        feature: "rtk",
        kind: "hook",
        event: "UserPromptSubmit",
        matcher: "",
        scriptName: "rtk hook claude",
        value: { type: "command", command: "rtk", args: ["hook", "claude"] },
      },
    ];
    const result = mergeSettings(request(current, desired));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(current);
    expect(result.records).toHaveLength(2);
  });

  it("does not add the rtk hook again on a repeated apply", () => {
    const desired: DesiredSettingEntry[] = [
      {
        id: "base-no-ampersand",
        feature: "base",
        kind: "hook",
        event: "PreToolUse",
        matcher: "Bash",
        scriptName: "no_ampersand.py",
        value: { type: "command", command: "python", args: ["/repo/hooks/no_ampersand.py"] },
      },
      {
        id: "rtk-pretooluse",
        feature: "rtk",
        kind: "hook",
        event: "PreToolUse",
        matcher: "Bash",
        scriptName: "rtk hook claude",
        value: { type: "command", command: "rtk", args: ["hook", "claude"] },
      },
    ];
    const first = mergeSettings(request("{}", desired));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = mergeSettings(request(first.text, desired, first.records));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.text).toBe(first.text);
    expect(second.text.split("\"hook\",\"claude\"")).toHaveLength(2);
    const third = mergeSettings(request(second.text, desired, second.records));
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.text).toBe(first.text);
  });

  it("does not add a duplicate when matching hooks occur more than once", () => {
    const current = "{\"hooks\":{\"Stop\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"command\",\"command\":\"python \\\"C:/a/reflect.py\\\"\"},{\"type\":\"command\",\"command\":\"py -3 C:/b/reflect.py\"}]}]}}";
    const desired: DesiredSettingEntry = {
      id: "reflection-stop",
      feature: "reflection",
      kind: "hook",
      event: "Stop",
      matcher: "",
      scriptName: "reflect.py",
      value: { type: "command", command: "python", args: ["/repo/reflect.py"] },
    };
    const result = mergeSettings(request(current, [desired]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe(current);
  });

  it("keeps a manually moved hook where it is and does not create a duplicate", () => {
    const current = "{\"hooks\":{\"Stop\":[{\"matcher\":\"Bash\",\"hooks\":[{\"type\":\"command\",\"command\":\"python /repo/reflect.py\"}]}]}}";
    const record: SettingsOwnershipRecord = {
      id: "reflection-stop",
      feature: "reflection",
      kind: "hook",
      event: "PreToolUse",
      matcher: "",
      scriptName: "reflect.py",
      value: { type: "command", command: "python /repo/reflect.py" },
    };
    const desired: DesiredSettingEntry = {
      id: "reflection-stop",
      feature: "reflection",
      kind: "hook",
      event: "PreToolUse",
      matcher: "",
      scriptName: "reflect.py",
      value: { type: "command", command: "python /repo/reflect.py" },
    };
    const first = mergeSettings(request(current, [desired], [record]));

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.text).toBe(current);
    expect(first.events).toHaveLength(1);
    const second = mergeSettings(request(current, [desired], first.records));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.events).toEqual([]);
  });


  it("keeps a hook whose command was changed and backs it up when disabled", () => {
    const current = "{\"hooks\":{\"Stop\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"command\",\"command\":\"python /repo/custom-hook.py\"}]}]}}";
    const record: SettingsOwnershipRecord = {
      id: "reflection-stop",
      feature: "reflection",
      kind: "hook",
      event: "Stop",
      matcher: "",
      scriptName: "reflect.py",
      value: { type: "command", command: "python /repo/reflect.py" },
      index: 0,
      groupIndex: 0,
      arrayLength: 1,
    };
    const desired: DesiredSettingEntry = {
      id: "reflection-stop",
      feature: "reflection",
      kind: "hook",
      event: "Stop",
      matcher: "",
      scriptName: "reflect.py",
      value: { type: "command", command: "python /repo/reflect.py" },
    };
    const first = mergeSettings(request(current, [desired], [record]));

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.text).toBe(current);
    expect(first.events).toHaveLength(1);
    const second = mergeSettings(request(current, [desired], first.records));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.events).toEqual([]);

    const disabled = mergeSettings(request(current, [], second.records));
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.text).not.toContain("custom-hook.py");
    expect(disabled.backupValues).toEqual([
      {
        id: "reflection-stop",
        location: ["hooks", "Stop", ""],
        value: { type: "command", command: "python /repo/custom-hook.py" },
      },
    ]);
  });

  it("removes an empty owned hook group and preserves one containing a foreign hook", () => {
    const record: SettingsOwnershipRecord = {
      id: "reflection-stop",
      feature: "reflection",
      kind: "hook",
      event: "Stop",
      matcher: "",
      scriptName: "reflect.py",
      value: { type: "command", command: "python /repo/reflect.py" },
    };
    const owned = "{\"hooks\":{\"Stop\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"command\",\"command\":\"python /repo/reflect.py\"}]}]}}";
    const foreign = "{\"hooks\":{\"Stop\":[{\"matcher\":\"\",\"hooks\":[{\"type\":\"command\",\"command\":\"python /repo/reflect.py\"},{\"type\":\"command\",\"command\":\"echo personal\"}]}]}}";
    const removed = mergeSettings(request(owned, [], [record]));

    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.text).not.toContain("reflect.py");
    expect(removed.text).not.toContain("\"matcher\"");

    const retained = mergeSettings(request(foreign, [], [record]));
    expect(retained.ok).toBe(true);
    if (!retained.ok) return;
    expect(retained.text).toContain("echo personal");
    expect(retained.text).toContain("\"matcher\":\"\"");
  });

  it("starts a new autoMode list with defaults before the owned entry", () => {
    const desired: DesiredSettingEntry = {
      id: "codex-auto-mode-allow",
      feature: "codex",
      kind: "list-entry",
      path: ["autoMode", "allow"],
      value: "Codex launcher is trusted",
    };
    const result = mergeSettings(request("{}", [desired]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("\"allow\":[\"$defaults\",\"Codex launcher is trusted\"]");
    expect(result.records).toHaveLength(1);
    const record = result.records[0];
    expect(record?.kind).toBe("list-entry");
    if (record?.kind !== "list-entry") return;
    expect(record.value).toBe("Codex launcher is trusted");
    expect(record.index).toBe(AUTO_MODE_ENTRY_INDEX);
  });

  it("preserves an existing autoMode defaults entry through enable and disable", () => {
    const current = "{ \"autoMode\": { \"allow\": [\"$defaults\"] } }";
    const desired: DesiredSettingEntry = {
      id: "codex-auto-mode-allow",
      feature: "codex",
      kind: "list-entry",
      path: ["autoMode", "allow"],
      value: "Codex launcher is trusted",
    };
    const enabled = mergeSettings(request(current, [desired]));

    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    expect(enabled.text).toContain("\"$defaults\"");
    expect(enabled.records).toHaveLength(1);
    const record = enabled.records[0];
    expect(record?.kind).toBe("list-entry");
    if (record?.kind !== "list-entry") return;
    expect(record.value).toBe("Codex launcher is trusted");

    const disabled = mergeSettings(request(enabled.text, [], enabled.records));
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.text).toBe("{ \"autoMode\": { \"allow\": [\"$defaults\"] } }");
    expect(disabled.records).toEqual([]);
  });

  it("does not add defaults to a foreign autoMode list", () => {
    const current = "{ \"autoMode\": { \"allow\": [\"Human rule\"] } }";
    const desired: DesiredSettingEntry = {
      id: "codex-auto-mode-allow",
      feature: "codex",
      kind: "list-entry",
      path: ["autoMode", "allow"],
      value: "Codex launcher is trusted",
    };
    const result = mergeSettings(request(current, [desired]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).not.toContain("$defaults");
    expect(result.text).toContain("\"allow\": [\"Human rule\",\"Codex launcher is trusted\"]");
  });

  it("does not write an autoMode list on a second unchanged pass", () => {
    const desired: DesiredSettingEntry = {
      id: "codex-auto-mode-allow",
      feature: "codex",
      kind: "list-entry",
      path: ["autoMode", "allow"],
      value: "Codex launcher is trusted",
    };
    const first = mergeSettings(request("{}", [desired]));

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = mergeSettings(request(first.text, [desired], first.records));

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.text).toBe(first.text);
    expect(second.changed).toBe(false);
  });

  it("does not adopt a user hook that runs the same script with other arguments", () => {
    const userHook = "{\"type\":\"command\",\"command\":\"python\",\"args\":[\"/u/reflect.py\",\"--mine\"]}";
    const current = "{\"hooks\":{\"Stop\":[{\"matcher\":\"\",\"hooks\":[" + userHook + "]}]}}";
    const desired: DesiredSettingEntry = {
      id: "reflection-stop",
      feature: "reflection",
      kind: "hook",
      event: "Stop",
      matcher: "",
      scriptName: "reflect.py",
      value: { type: "command", command: "python", args: ["/repo/reflect.py"] },
    };
    const applied = mergeSettings(request(current, [desired]));

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.text).toContain("--mine");
    const disabled = mergeSettings(request(applied.text, [], applied.records));
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.text).toContain("--mine");
    expect(disabled.text).not.toContain("/repo/reflect.py");
  });

  it("tracks and removes one script registered on two events", () => {
    const stop: DesiredSettingEntry = {
      id: "reflection-stop",
      feature: "reflection",
      kind: "hook",
      event: "Stop",
      matcher: "",
      scriptName: "reflect.py",
      value: { type: "command", command: "python", args: ["/repo/reflect.py"] },
    };
    const pre: DesiredSettingEntry = { ...stop, id: "reflection-pre", event: "PreToolUse" };
    const applied = mergeSettings(request("{}", [stop, pre]));

    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.records).toHaveLength(2);
    const again = mergeSettings(request(applied.text, [stop, pre], applied.records));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.text).toBe(applied.text);
    const disabled = mergeSettings(request(applied.text, [], applied.records));
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.text).not.toContain("reflect.py");
  });

  it("backs up and reports a user entry that sits at the recorded place of a removed hook", () => {
    const a = "{\"type\":\"command\",\"command\":\"echo a\"}";
    const b = "{\"type\":\"command\",\"command\":\"echo b\"}";
    const x = "{\"type\":\"command\",\"command\":\"echo mine\"}";
    const current = "{\"hooks\":{\"Stop\":[{\"matcher\":\"\",\"hooks\":[" + a + "," + x + "," + b + "]}]}}";
    const record: SettingsOwnershipRecord = {
      id: "reflection-stop",
      feature: "reflection",
      kind: "hook",
      event: "Stop",
      matcher: "",
      scriptName: "reflect.py",
      value: { type: "command", command: "python /repo/reflect.py" },
      index: 1,
      groupIndex: 0,
      beforeValue: { type: "command", command: "echo a" },
      afterValue: { type: "command", command: "echo b" },
    };
    const disabled = mergeSettings(request(current, [], [record]));

    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.backupValues).toHaveLength(1);
    expect(disabled.events).toHaveLength(1);
  });

  it("removes one owned hook when the user duplicated it", () => {
    const entry = "{\"type\":\"command\",\"command\":\"python\",\"args\":[\"/repo/reflect.py\"]}";
    const current = "{\"hooks\":{\"Stop\":[{\"matcher\":\"\",\"hooks\":[" + entry + "," + entry + "]}]}}";
    const record: SettingsOwnershipRecord = {
      id: "reflection-stop",
      feature: "reflection",
      kind: "hook",
      event: "Stop",
      matcher: "",
      scriptName: "reflect.py",
      value: { type: "command", command: "python", args: ["/repo/reflect.py"] },
      index: 0,
      groupIndex: 0,
    };
    const disabled = mergeSettings(request(current, [], [record]));

    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.events).toEqual([]);
    expect(disabled.text).toContain("reflect.py");
    expect(disabled.text.split("reflect.py")).toHaveLength(2);
  });
});
