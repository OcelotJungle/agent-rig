import type { RuntimePorts } from "./ports.js";

// A file operation that fails on a busy file (EPERM, EBUSY or EACCES) is tried this many times...
const BUSY_TRIES = 10;
// ...with this pause between tries (ms), about two seconds in all.
const BUSY_RETRY_MS = 200;

export const isBusy = (value: unknown): boolean => typeof value === "object" && value !== null && "code" in value && (value.code === "EPERM" || value.code === "EBUSY" || value.code === "EACCES");

// Runs the action, retrying through the injected clock while the file is busy; the last error is thrown once the tries are spent.
export const retryWhileBusy = async <T>(runtime: RuntimePorts, action: () => Promise<T>): Promise<T> => {
	for (let attempt = 1; ; attempt++) {
		try { return await action(); } catch (error) {
			if (attempt >= BUSY_TRIES || !isBusy(error)) throw error;
			await runtime.clock.sleep(BUSY_RETRY_MS);
		}
	}
};
