// Queue identifiers and wire shapes shared by rig and the window.
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const REQUEST_SUFFIX = ".json";
// A request is claimed by making the directory claims/<id> (the one atomic step the engine offers: mkdir fails on an
// existing directory); the claimant then writes its Claude pid to claims/<id>/pid. Rig decides the claimant is gone from
// that pid's identity (pid and creation time), never from elapsed time.
export const CLAIMS_DIR = "claims";
export const CLAIM_PID_FILE = "pid";
// claims/<id>/state: what the claiming module observes about the request, so rig reports progress from a fact, never
// from elapsed time. Written on every change: `waiting` (it cannot start now) or `running` (the op has started).
export const CLAIM_STATE_FILE = "state";
export const CLAIM_STATE_WAITING = "waiting";
export const CLAIM_STATE_RUNNING = "running";
export const OPS = ["compact", "rename", "autocompact", "usage", "mode", "prompt"] as const;
export type Op = (typeof OPS)[number];
export type Args = Record<string, unknown>;
export type Request = { id: string; op: Op; args: Args };
export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
export type Response = { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string };
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export function isOp(v: unknown): v is Op { return OPS.some((op) => op === v); }
export function idOfFile(name: string): string | undefined {
	if (!name.endsWith(REQUEST_SUFFIX)) return undefined;
	const id = name.slice(0, -REQUEST_SUFFIX.length);
	return ID_PATTERN.test(id) ? id : undefined;
}
export function parseRequest(fileId: string, text: string): Parsed<Request> {
	let body: unknown;
	try { body = JSON.parse(text); } catch { return { ok: false, error: "the request is not valid JSON" }; }
	if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "the request is not a JSON object" };
	if (!("id" in body) || body.id !== fileId) return { ok: false, error: "the request id differs from its file name" };
	if (!("op" in body) || !isOp(body.op)) return { ok: false, error: `unknown op: ${String("op" in body ? body.op : undefined)}` };
	const args = "args" in body ? body.args ?? {} : {};
	if (!isRecord(args)) return { ok: false, error: "args is not an object" };
	return { ok: true, value: { id: fileId, op: body.op, args } };
}
export function responseText(response: Response): string { return JSON.stringify(response); }
