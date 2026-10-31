import type { Result } from "../result.js";
import type { RuntimePorts } from "../ports.js";

import { applyRig } from "../apply.js";
import { ok } from "../result.js";
import { readRigState, withRigLock } from "./shared.js";

export const applyCommand = async (runtime: RuntimePorts, writeLine: (line: string) => void): Promise<Result<void>> =>
	withRigLock(runtime, writeLine, async () => {
		const state = await readRigState(runtime);
		if (!state.ok) return state;
		const applied = await applyRig(runtime, { state: state.value, mode: "apply" });
		if (!applied.ok) return applied;
		writeLine(applied.value.changedFiles.length === 0 ? "Конфигурация rig уже актуальна." : `Обновлено файлов: ${applied.value.changedFiles.length}.`);
		return ok(undefined);
	});
