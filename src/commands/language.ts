import type { Language } from "../messages.js";
import type { Result } from "../result.js";
import type { RuntimePorts } from "../ports.js";

import { DEFAULT_LANGUAGE, messagesFor } from "../messages.js";
import { ok } from "../result.js";
import { writeState } from "../state.js";
import { emitRigEvent, readRigState, withRigLock } from "./shared.js";

export const LANGUAGE_EVENT_TYPE = "language-changed";

const languageLine = (language: Language): string => {
	const messages = messagesFor(language);
	return messages.language.line(messages.languageNames[language]);
};

// `rig language`: prints the language in effect, as text or as `{"language":"en"}`.
export const showLanguage = (runtime: RuntimePorts, json: boolean, writeLine: (line: string) => void): Result<void> => {
	writeLine(json ? JSON.stringify({ language: runtime.language }) : languageLine(runtime.language));
	return ok(undefined);
};

// `rig language en|ru`: under the rig lock, writes the language to state.json, records an event and prints the
// sentence, both in the NEW language. Setting the language that is already in force changes and emits nothing.
export const setLanguage = async (
	runtime: RuntimePorts,
	language: Language,
	json: boolean,
	writeLine: (line: string) => void,
): Promise<Result<void>> => withRigLock(runtime, writeLine, async () => {
	const stateResult = await readRigState(runtime);
	if (!stateResult.ok) return stateResult;
	const text = languageLine(language);
	if ((stateResult.value.language ?? DEFAULT_LANGUAGE) !== language) {
		const written = await writeState(runtime.fs, runtime.home, { ...stateResult.value, language });
		if (!written.ok) return written;
		const event = await emitRigEvent(runtime, LANGUAGE_EVENT_TYPE, "info", text);
		if (!event.ok) return event;
	}
	writeLine(json ? JSON.stringify({ language }) : text);
	return ok(undefined);
});
