import type { RuntimePorts } from "./ports.js";

// A transcript is searched backwards in blocks of this size (1 MiB).
const SCAN_BLOCK_BYTES = 1024 * 1024;

// The last line of the transcript, counted from the end, for which `pick` returns a value; lines that are not valid
// JSON (a torn last line) are skipped. Null when no line matches. A read error is thrown to the caller.
export const scanTranscriptBackwards = async <T>(runtime: RuntimePorts, path: string, pick: (value: unknown) => T | null): Promise<T | null> => {
	const stat = await runtime.fs.stat(path);
	if (stat === null) return null;
	let end = stat.size;
	let suffix = Buffer.alloc(0);
	while (end > 0) {
		const start = Math.max(0, end - SCAN_BLOCK_BYTES);
		const block = Buffer.concat([await runtime.fs.readRange(path, start, end - start), suffix]);
		const boundary = start === 0 ? 0 : block.indexOf("\n") + 1;
		if (start !== 0 && boundary === 0) { suffix = block; end = start; continue; }
		for (const line of block.subarray(boundary).toString("utf8").split("\n").reverse()) {
			let value: unknown;
			try { value = JSON.parse(line); } catch { continue; }
			const picked = pick(value);
			if (picked !== null) return picked;
		}
		suffix = block.subarray(0, boundary);
		end = start;
	}
	return null;
};
