import type { Language } from "../messages.js";
import type { Result } from "../result.js";
import type { RuntimePorts } from "../ports.js";

import { DEFAULT_LANGUAGE, messagesFor } from "../messages.js";
import { err, ok } from "../result.js";
import { readStateReport, writeState } from "../state.js";
import { emitRigEvent, withRigLock } from "./shared.js";

export const LANGUAGE_EVENT_TYPE = "language-changed";

const languageLine = (language: Language): string => {
	const messages = messagesFor(language);
	return messages.language.line(messages.languageNames[language]);
};

// `rig language`: prints the language in effect, as text or as `{"language":"en"}`. Without state.json rig is not
// installed and there is no setting to show.
export const showLanguage = async (runtime: RuntimePorts, json: boolean, writeLine: (line: string) => void): Promise<Result<void>> => {
	const stored = await readStateReport(runtime.fs, runtime.home);
	if (!stored.ok) return stored;
	if (stored.value === null) return err(messagesFor(runtime.language).language.notInstalled());
	writeLine(json ? JSON.stringify({ language: runtime.language }) : languageLine(runtime.language));
	return ok(undefined);
};

// `rig language en|ru`: under the rig lock, writes the language to state.json, records an event and prints the
// sentence, both in the NEW language. Setting the language that is already in force changes and emits nothing, except
// that an unsupported value in state.json (read as English everywhere) is replaced by a valid one: repair, without an event.
export const setLanguage = async (
	runtime: RuntimePorts,
	language: Language,
	json: boolean,
	writeLine: (line: string) => void,
): Promise<Result<void>> => withRigLock(runtime, writeLine, async () => {
	const stored = await readStateReport(runtime.fs, runtime.home);
	if (!stored.ok) return stored;
	if (stored.value === null) return err(messagesFor(runtime.language).language.notInstalled());
	const { state, languageInvalid } = stored.value;
	const text = languageLine(language);
	const changed = (state.language ?? DEFAULT_LANGUAGE) !== language;
	if (changed || languageInvalid) {
		const written = await writeState(runtime.fs, runtime.home, { ...state, language });
		if (!written.ok) return written;
	}
	if (changed) {
		const event = await emitRigEvent(runtime, LANGUAGE_EVENT_TYPE, "info", text);
		if (!event.ok) return event;
	}
	writeLine(json ? JSON.stringify({ language }) : text);
	return ok(undefined);
});
