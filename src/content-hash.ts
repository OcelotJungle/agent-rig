import { createHash } from "node:crypto";

const HASH_ALGORITHM = "sha256";
// An executable file hashes differently from the same bytes without the bit, so a mode change counts as a change.
const EXECUTABLE_SUFFIX = "+x";

export type FileContent = {
	bytes: Uint8Array;
	executable: boolean;
};

export const hashBytes = (bytes: Uint8Array): string => createHash(HASH_ALGORITHM).update(bytes).digest("hex");

export const hashText = (text: string): string => createHash(HASH_ALGORITHM).update(text, "utf8").digest("hex");

export const hashContent = (content: FileContent): string =>
	`${hashBytes(content.bytes)}${content.executable ? EXECUTABLE_SUFFIX : ""}`;

export const textContent = (text: string): FileContent => ({ bytes: new TextEncoder().encode(text), executable: false });
