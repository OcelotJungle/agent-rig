import type { AssetPlan } from "../../src/assets/installer";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyAssets } from "../../src/assets/installer";
import { createNodeAssetFileSystem } from "../../src/assets/node-asset-file-system";

const DAY = "2026-10-30";
const TEMP_PREFIX = "rig-assets-";
const OWNER_EXECUTE_BIT = 0o100;
const NO_BITS = 0;
// Not valid UTF-8 (0xFF, 0xFE, 0xC3 0x28) and holds a NUL byte, like a picture header.
const BINARY_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80]);
const SCRIPT_TEXT = "#!/bin/sh\necho {{HOME}}\n";
const IS_WINDOWS = process.platform === "win32";

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("real file system adapter (A8)", () => {
  test("a skill with a binary file and a script is copied byte for byte with its exec bit", async () => {
    const source = join(root, "clone", "skills", "one");
    const target = join(root, "home", ".claude", "skills", "one");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "nested", "logo.png"), BINARY_BYTES);
    await writeFile(join(source, "run.sh"), SCRIPT_TEXT);
    if (!IS_WINDOWS) await chmod(join(source, "run.sh"), 0o755);
    const plan: AssetPlan = {
      enabled: true,
      clonePath: join(root, "clone"),
      homePath: join(root, "home"),
      hubPath: join(root, "hub"),
      pythonPath: "python",
      files: [{ sourcePath: source, targetPath: target }],
    };

    const applied = await applyAssets({ fs: createNodeAssetFileSystem(), now: () => DAY }, [plan], {});

    expect(applied.ok).toBe(true);
    expect(new Uint8Array(await readFile(join(target, "nested", "logo.png")))).toEqual(BINARY_BYTES);
    expect(await readFile(join(target, "run.sh"), "utf8")).toBe(`#!/bin/sh\necho ${join(root, "home").replaceAll("\\", "/")}\n`);
    if (IS_WINDOWS) return;
    const mode = (await stat(join(target, "run.sh"))).mode;
    expect(mode & OWNER_EXECUTE_BIT).not.toBe(NO_BITS);
    expect((await stat(join(target, "nested", "logo.png"))).mode & OWNER_EXECUTE_BIT).toBe(NO_BITS);
  });

  test("readFile returns the raw bytes of a file that is not UTF-8", async () => {
    const path = join(root, "logo.png");
    await writeFile(path, BINARY_BYTES);

    const read = await createNodeAssetFileSystem().readFile(path);

    expect(read.ok && read.value.bytes).toEqual(BINARY_BYTES);
  });
});
