import type { RuntimePorts } from "./ports.js";

// A transcript is searched backwards in blocks of this size (1 MiB).
const SCAN_BLOCK_BYTES = 1024 * 1024;
const LINE_FEED = 0x0a;

// Where a read of the bytes after `offset` must start to begin on a line: `offset` itself when the byte before it ends a
// line, else the start of the line that byte is in (just after the last line feed before it, or 0). The file is read
// backwards in blocks, never whole.
export const lineStartAtOrBefore = async (runtime: RuntimePorts, path: string, offset: number): Promise<number> => {
	let end = offset;
	let first = true;
	while (end > 0) {
		const start = Math.max(0, end - SCAN_BLOCK_BYTES);
		const block = await runtime.fs.readRange(path, start, end - start);
		// The first byte looked at is the last scanned one: a line feed there means the offset is already a line start.
		if (first && block[block.length - 1] === LINE_FEED) return offset;
		first = false;
		const at = block.lastIndexOf(LINE_FEED);
		if (at !== -1) return start + at + 1;
		end = start;
	}
	return 0;
};

// The last line of the transcript, counted from the end, for which `pick` returns a value; lines that are not valid
// JSON (a torn last line) are skipped. Null when no line matches. A read error is thrown to the caller. `from` limits the
// scan to the bytes at and after that offset, which the caller knows to be where a line starts (the default is the file's start).
export const scanTranscriptBackwards = async <T>(runtime: RuntimePorts, path: string, pick: (value: unknown) => T | null, from = 0): Promise<T | null> => {
	const stat = await runtime.fs.stat(path);
	if (stat === null) return null;
	let end = stat.size;
	let suffix = Buffer.alloc(0);
	while (end > from) {
		const start = Math.max(from, end - SCAN_BLOCK_BYTES);
		const block = Buffer.concat([await runtime.fs.readRange(path, start, end - start), suffix]);
		const boundary = start === from ? 0 : block.indexOf("\n") + 1;
		if (start !== from && boundary === 0) { suffix = block; end = start; continue; }
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
