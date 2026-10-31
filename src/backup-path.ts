import type { Result } from "./result.js";

import { err, ok } from "./result.js";

const FIRST_BACKUP_NUMBER = 1;
// A day cannot realistically need more copies than this; the cap only stops a runaway loop.
const MAX_BACKUP_NUMBER = 1000;

export type BackupChoice = {
	path: string;
	// True when the chosen path already holds exactly the wanted content, so nothing has to be written.
	exists: boolean;
};

// Picks `base`, then `base-2`, `base-3`, ... : the first path that is free or already holds the wanted content.
// A copy with other content is never overwritten and never reused.
export const chooseBackupPath = async (
	basePath: string,
	wantedHash: string,
	readHash: (path: string) => Promise<Result<string | null>>,
): Promise<Result<BackupChoice>> => {
	for (let number = FIRST_BACKUP_NUMBER; number <= MAX_BACKUP_NUMBER; number += 1) {
		const path = number === FIRST_BACKUP_NUMBER ? basePath : `${basePath}-${number}`;
		const existing = await readHash(path);
		if (!existing.ok) return existing;
		if (existing.value === null) return ok({ path, exists: false });
		if (existing.value === wantedHash) return ok({ path, exists: true });
	}
	return err(`Too many backups of ${basePath}`);
};
