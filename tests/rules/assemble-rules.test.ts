import type { RuleChunk, RuleFile, RuleFilePorts } from "../../src/rules/assemble-rules";

import { describe, expect, test } from "bun:test";
import { resolvePlaceholders } from "../../src/placeholders";
import { assembleRules, ensureClaudeImports, updateRuleFiles } from "../../src/rules/assemble-rules";

const shared: RuleChunk = { target: "shared", text: "Shared policy" };
const claude: RuleChunk = { target: "claude", text: "Claude policy" };

describe("rule assembly", () => {
  test("builds shared and Claude text separately", () => {
    const result = assembleRules([shared, claude]);

    expect(result.codex).toBe("<!-- rig:begin -->\nShared policy\n<!-- rig:end -->");
    expect(result.claude).toBe("Claude policy");
    expect(result.claude).not.toContain("Shared policy");
    expect(result.repairs).toEqual([]);
  });

	test("keeps chunk order and section adjacency while separating targets", () => {
		const result = assembleRules([
			{ target: "claude", text: "Section 01 part 01" },
			{ target: "shared", text: "Shared policy" },
			{ target: "claude", text: "Section 01 part 02" },
			{ target: "claude", text: "Section 02 part 01" },
		]);

		expect(result.claude).toBe("Section 01 part 01\nSection 01 part 02\nSection 02 part 01");
		expect(result.codex).toContain("Shared policy");
	});

	test("substitutes double-brace placeholders and rejects unresolved names", () => {
		expect(resolvePlaceholders("{{CLONE}}/tools/patchlib.py via {{PYTHON}}", {
			CLONE: "C:/agent-rig",
			PYTHON: "python",
		}, "test rule")).toEqual({ ok: true, value: "C:/agent-rig/tools/patchlib.py via python" });
		expect(resolvePlaceholders("{{UNKNOWN}}", {}, "test rule")).toEqual({ ok: false, error: "Unresolved placeholder {{UNKNOWN}} in test rule" });
		expect(resolvePlaceholders("{{FIRST}} and {{SECOND}} and {{FIRST}}", {}, "test rule")).toEqual({
			ok: false,
			error: "Unresolved placeholder {{FIRST}}, {{SECOND}} in test rule",
		});
  });

  test("replaces a valid block and preserves outside text", () => {
    const result = assembleRules([shared], {
      codex: "before\n<!-- rig:begin -->\nold\n<!-- rig:end -->\nafter",
    });

    expect(result.codex).toBe("before\n<!-- rig:begin -->\nShared policy\n<!-- rig:end -->\nafter");
    expect(result.repairs).toEqual([]);
  });

  test("starts a missing block at the beginning", () => {
    const result = assembleRules([shared], { codex: "personal" });

    expect(result.codex).toBe("<!-- rig:begin -->\nShared policy\n<!-- rig:end -->\npersonal");
  });

  test("repairs one marker without losing text", () => {
    const result = assembleRules([shared], { codex: "personal\n<!-- rig:begin -->\nold block" });

    expect(result.codex).toContain("personal\n");
    expect(result.codex).toContain("old block");
    expect(result.codex).toContain("<!-- rig:begin -->\nShared policy\n<!-- rig:end -->");
    expect(result.repairs).toEqual(["codex"]);
  });

  test("repairs reversed markers without losing text", () => {
    const result = assembleRules([shared], { codex: "left\n<!-- rig:end -->\nkept\n<!-- rig:begin -->\nright" });

    expect(result.codex).toContain("left");
    expect(result.codex).toContain("kept");
    expect(result.codex).toContain("right");
    expect(result.repairs).toEqual(["codex"]);
  });

  test("repairs two marker pairs without losing either region", () => {
    const result = assembleRules([shared], {
      codex: "a\n<!-- rig:begin -->\nfirst\n<!-- rig:end -->\nb\n<!-- rig:begin -->\nsecond\n<!-- rig:end -->\nc",
    });

    expect(result.codex).toContain("first");
    expect(result.codex).toContain("second");
    expect(result.codex).toContain("a");
    expect(result.codex).toContain("b");
    expect(result.codex).toContain("c");
    expect(result.repairs).toEqual(["codex"]);
  });

  test("preserves CRLF and BOM while replacing the block", () => {
    const source = "\uFEFFoutside\r\n<!-- rig:begin -->\r\nold\r\n<!-- rig:end -->\r\ntail";
    const result = assembleRules([shared], { codex: source });

    expect(result.codex).toBe("\uFEFFoutside\r\n<!-- rig:begin -->\r\nShared policy\r\n<!-- rig:end -->\r\ntail");
  });

  test("preserves BOM and CRLF when repairing a single marker", () => {
    const result = assembleRules([shared], { codex: "\uFEFFone\r\n<!-- rig:begin -->\r\nold" });

    expect(result.codex.startsWith("\uFEFF<!-- rig:begin -->\r\nShared policy\r\n<!-- rig:end -->\r\n")).toBe(true);
    expect(result.codex).toContain("one\r\nold");
  });

  test("keeps a marker example written inside a sentence outside the block (A10)", () => {
    const source = "Say <!-- rig:begin --> to open a block\n<!-- rig:begin -->\nold\n<!-- rig:end -->\ntail";
    const result = assembleRules([shared], { codex: source });

    expect(result.codex).toBe("Say <!-- rig:begin --> to open a block\n<!-- rig:begin -->\nShared policy\n<!-- rig:end -->\ntail");
    expect(result.repairs).toEqual([]);
  });

  test("keeps an inline marker example while repairing a broken pair (A10)", () => {
    const source = "Close it with <!-- rig:end --> please\n<!-- rig:begin -->\nold block";
    const result = assembleRules([shared], { codex: source });

    expect(result.codex).toContain("Close it with <!-- rig:end --> please\n");
    expect(result.codex).toContain("old block");
    expect(result.codex).toContain("<!-- rig:begin -->\nShared policy\n<!-- rig:end -->");
    expect(result.repairs).toEqual(["codex"]);
    expect(assembleRules([shared], { codex: result.codex }).codex).toBe(result.codex);
  });

  test("adds missing exact imports at the top and leaves existing text intact", () => {
    expect(ensureClaudeImports("personal\n@../.codex/AGENTS.md")).toBe(
      "@../.agent-rig/generated/CLAUDE.md\npersonal\n@../.codex/AGENTS.md",
    );
  });

  test("does not duplicate imports found as exact lines", () => {
    const source = "@../.codex/AGENTS.md\n@../.agent-rig/generated/CLAUDE.md\npersonal";

    expect(ensureClaudeImports(source)).toBe(source);
  });
});

describe("atomic rule file updates", () => {
  test("skips unchanged content, writes changed content atomically, and backs up once", async () => {
    const files = new Map<string, string>([["codex", "before"]]);
    const writes: Array<[string, string]> = [];
    const renames: Array<[string, string]> = [];
    const ports = createMemoryPorts(files, writes, renames);
    const targets: RuleFile[] = [
      { path: "codex", content: "before" },
      { path: "generated", content: "new rules" },
    ];

    const first = await updateRuleFiles(targets, ports);
    const second = await updateRuleFiles(targets, ports);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(files.get("codex")).toBe("before");
    expect(files.get("generated")).toBe("new rules");
    expect(files.get("codex.bak-2026-10-30")).toBeUndefined();
    expect(files.get("generated.bak-2026-10-30")).toBeUndefined();
    expect(writes).toHaveLength(1);
    expect(writes.some(([path]) => path.endsWith(".tmp"))).toBe(true);
    expect(renames).toContainEqual(["generated.tmp", "generated"]);
  });

  test("creates a dated backup only for changed existing content", async () => {
    const files = new Map<string, string>([["codex", "old"]]);
    const writes: Array<[string, string]> = [];
    const renames: Array<[string, string]> = [];
    const result = await updateRuleFiles(
      [{ path: "codex", content: "new" }],
      createMemoryPorts(files, writes, renames),
    );

    expect(result.ok).toBe(true);
    expect(files.get("codex")).toBe("new");
    expect(files.get("codex.bak-2026-10-30")).toBe("old");
    expect(renames).toContainEqual(["codex.bak-2026-10-30.tmp", "codex.bak-2026-10-30"]);
  });
});

function createMemoryPorts(
  files: Map<string, string>,
  writes: Array<[string, string]>,
  renames: Array<[string, string]>,
): RuleFilePorts {
  return {
    clock: () => "2026-10-30",
    read: async (path) => ({ ok: true, value: files.get(path) ?? null }),
    write: async (path, content) => {
      writes.push([path, content]);
      files.set(path, content);
      return { ok: true, value: undefined };
    },
    rename: async (from, to) => {
      renames.push([from, to]);
      const content = files.get(from);
      if (content === undefined) {
        return { ok: false, error: `missing ${from}` };
      }
      files.set(to, content);
      files.delete(from);
      return { ok: true, value: undefined };
    },
  };
}
