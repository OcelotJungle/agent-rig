import type { Result } from "../result.js";
import type { FileSystem } from "./installer.js";
import type { FileContent } from "../content-hash.js";

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { toSlashPath } from "../file-system.js";
import { err, errorText, ok } from "../result.js";

const TRAILING_SLASHES = /\/+$/;
const EXECUTABLE_FILE_MODE = 0o755;
const REGULAR_FILE_MODE = 0o644;
const ANY_EXECUTE_BITS = 0o111;
const NO_BITS = 0;

// Files are moved as bytes with their exec bit: a skill may carry a picture, a font or a script.
export function createNodeAssetFileSystem(): FileSystem {
  return {
    readFile: async (path) => {
      try {
        const [bytes, stat] = await Promise.all([fs.readFile(path), fs.stat(path)]);
        return ok({ bytes: new Uint8Array(bytes), executable: (stat.mode & ANY_EXECUTE_BITS) !== NO_BITS });
      } catch (error) {
        return err(isMissing(error) ? "not-found" : errorText(error));
      }
    },
    listFiles: async (path) => {
      try {
        const files: string[] = [];
        await collectFiles(path, files);
        return ok(files);
      } catch (error) {
        return err(errorText(error));
      }
    },
    writeFileAtomic: (path, content) => writeBytesAtomic(path, content),
    removeFile: async (path) => {
      try {
        await fs.unlink(path);
        return ok(undefined);
      } catch (error) {
        return err(errorText(error));
      }
    },
    makeDirectory: async (path) => {
      try {
        await fs.mkdir(path, { recursive: true });
        return ok(undefined);
      } catch (error) {
        return err(errorText(error));
      }
    },
    realPath: async (path) => {
      try {
        return ok(await fs.realpath(path));
      } catch (error) {
        return err(isMissing(error) ? "not-found" : errorText(error));
      }
    },
  };
}

async function writeBytesAtomic(path: string, content: FileContent): Promise<Result<void>> {
  const temporary = join(dirname(path), `${path.split(/[\\/]/).pop() ?? "file"}.tmp-${randomUUID()}`);
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(temporary, content.bytes, { mode: content.executable ? EXECUTABLE_FILE_MODE : REGULAR_FILE_MODE });
    // The mode given to writeFile is cut by the umask, so the exec bit is set again explicitly.
    await fs.chmod(temporary, content.executable ? EXECUTABLE_FILE_MODE : REGULAR_FILE_MODE);
    await fs.rename(temporary, path);
    return ok(undefined);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    return err(errorText(error));
  }
}

async function collectFiles(directory: string, files: string[]): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${toSlashPath(directory).replace(TRAILING_SLASHES, "")}/${entry.name}`;
    if (entry.isDirectory()) await collectFiles(path, files);
    else if (entry.isFile()) files.push(path);
  }
}

function isMissing(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT" || error.code === "ENOTDIR";
}
