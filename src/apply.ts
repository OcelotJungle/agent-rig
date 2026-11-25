import type { AssetManifest, FeatureManifest, HookManifest } from "./feature.js";
import type { JsonObject, DesiredSettingEntry } from "./settings/merge-settings.js";
import type { AssetPlan, AssetRecord, PluginPlan, PluginRecord } from "./assets/installer.js";
import type { JournalDependencies, PlannedEvent } from "./apply-journal.js";
import type { Language, Messages } from "./messages.js";
import type { RigState } from "./state.js";
import type { Result } from "./result.js";
import type { RuntimePorts } from "./ports.js";
import type { FileSystem } from "./file-system.js";
import type { HookPrograms } from "./hook-programs.js";
import type { ProgressEvent } from "./output.js";

import { buildJournal, emitJournalEvents, isRigRecordKey, planEvents, recoverRecords } from "./apply-journal.js";
import { executeAssetOperations, planAssets, applyPlugins } from "./assets/installer.js";
import { chooseBackupPath } from "./backup-path.js";
import { hashText } from "./content-hash.js";
import { assembleRules, ensureClaudeImports, executeRuleFilePlan, planRuleFiles } from "./rules/assemble-rules.js";
import { resolveJsonPlaceholders, resolvePlaceholders } from "./placeholders.js";
import { resolveHookPrograms, resolvedHookCommand } from "./hook-programs.js";
import { mergeSettings } from "./settings/merge-settings.js";
import { isTranslatedLanguage, messagesFor } from "./messages.js";
import { atomicWrite, joinPath, toSlashPath } from "./file-system.js";
import { err, errorText, ok } from "./result.js";
import { loadFeatures } from "./feature-graph.js";
import { parseState, writeState } from "./state.js";

const SETTINGS_RECORD_PREFIX = "setting:";
const ASSET_RECORD_PREFIX = "asset:";
const PLUGIN_RECORD_PREFIX = "plugin:";
const AGENT_SOURCE_PREFIX = "agents/";
const SKILL_SOURCE_PREFIX = "skills/";
const CLAUDE_PLUGINS_OFFICIAL_SOURCE = "https://github.com/anthropics/claude-plugins-official";
const OPENAI_CODEX_SOURCE = "https://github.com/openai/codex-plugin-cc";
const SETTINGS_FILENAME = "settings.json";
const ISO_DATE_LENGTH = 10;
const UPDATE_CHANNEL_SETTING_ID = "rig-update-channel";
const UPDATE_CHANNEL_PATH = ["autoUpdatesChannel"];
const SERVER_UPDATE_CHANNEL = "stable";
const EMPTY_SETTINGS_TEXT = "{}\n";
const MARKETPLACE_DIRECTORY = ".claude-plugin";
const MARKETPLACE_FILENAME = "marketplace.json";
const RIG_PLUGIN_PREFIX = "rig:";
const RIG_PLUGINS_DIRECTORY = "plugins";

export type ApplyRequest = {
	state: RigState;
	mode: "install" | "apply";
};

export type ApplyOutcome = {
	state: RigState;
	changedFiles: string[];
	// Plugin installs and uninstalls and marketplace adds and removals that apply made through the claude CLI.
	pluginChanges: PluginChanges;
};

export type PluginChanges = {
	installed: string[];
	updated: string[];
	uninstalled: string[];
	marketplacesAdded: string[];
	marketplacesRemoved: string[];
};

export const applyRig = async (
	runtime: RuntimePorts,
	request: ApplyRequest,
	writeProgress: (event: ProgressEvent) => void = () => undefined,
): Promise<Result<ApplyOutcome>> => {
	const messages = messagesFor(runtime.language);
	const featuresResult = await loadFeatures(runtime.fs, request.state.paths.repo, messages);
	if (!featuresResult.ok) return featuresResult;
	const manifests = featuresResult.value;
	const enabled = new Set(manifests.filter((feature) => feature.name === "base" || request.state.features[feature.name] === true).map((feature) => feature.name));
	const platform = runtime.platform;
	const claudeHome = joinPath(runtime.home, ".claude");
	const codexPath = joinPath(runtime.home, ".codex", "AGENTS.md");
	const generatedPath = joinPath(runtime.home, ".agent-rig", "generated", "CLAUDE.md");
	const claudePath = joinPath(claudeHome, "CLAUDE.md");
	const settingsPath = joinPath(claudeHome, SETTINGS_FILENAME);
	const statePath = joinPath(runtime.home, ".agent-rig", "state.json");
	const [codexRead, generatedRead, claudeRead, settingsRead, stateRead] = await Promise.all([
		readOptional(runtime, codexPath, messages),
		readOptional(runtime, generatedPath, messages),
		readOptional(runtime, claudePath, messages),
		readOptional(runtime, settingsPath, messages),
		readOptional(runtime, statePath, messages),
	]);
	if (!codexRead.ok) return codexRead;
	if (!generatedRead.ok) return generatedRead;
	if (!claudeRead.ok) return claudeRead;
	if (!settingsRead.ok) return settingsRead;
	if (!stateRead.ok) return stateRead;
	let persistedState: RigState | null = null;
	if (stateRead.value !== null) {
		const parsedState = parseState(stateRead.value, messages);
		if (!parsedState.ok) return parsedState;
		persistedState = parsedState.value;
	}
	const baseState = withoutJournal(request.state);
	const journalDependencies: JournalDependencies = {
		messages,
		fs: runtime.fs,
		assetFs: runtime.assetFs,
		home: runtime.home,
		clock: runtime.clock,
		ids: runtime.ids,
	};

	// A killed run leaves its journal: take the ownership records of what it did write, then go on from there.
	const leftoverJournal = persistedState?.journal ?? request.state.journal;
	let records = request.state.records;
	const leftoverEvents = leftoverJournal?.events ?? [];
	if (leftoverJournal !== undefined) {
		const recovered = await recoverRecords(journalDependencies, leftoverJournal, request.state.records, settingsPath);
		if (!recovered.ok) return recovered;
		records = recovered.value;
	}

	const today = runtime.clock.nowText().slice(0, ISO_DATE_LENGTH);
	const settingsBackupBase = `${settingsPath}.bak-${today}`;
	const hookPrograms = await resolveHookPrograms(runtime, manifests, enabled);
	if (!hookPrograms.ok) return hookPrograms;
	const placeholders = {
		CLONE: toSlashPath(request.state.paths.repo),
		HUB: toSlashPath(request.state.paths.hub),
		HOME: toSlashPath(runtime.home),
		// Text placeholders (rules, agents, permission strings) keep the bare name agents type; only hook commands are absolute.
		PYTHON: toSlashPath(runtime.pythonCommand),
	};
	const chunksResult = await loadRuleChunks(runtime, manifests, enabled, platform, request.state.paths.repo, placeholders);
	if (!chunksResult.ok) return chunksResult;
	const assembled = assembleRules(chunksResult.value, { codex: codexRead.value ?? "" });
	const desiredSettingsResult = buildDesiredSettings(manifests, enabled, runtime, placeholders, request.state.mode, hookPrograms.value);
	if (!desiredSettingsResult.ok) return desiredSettingsResult;
	const settingRecords = parseSettingRecords(records);
	const invalidSettings = (error: string): string => messages.apply.settingsInvalid(error, settingsPath);
	// A first merge only checks that settings.json can be merged. Nothing is written until every plan is valid.
	const draftMerge = mergeSettings({
		currentText: settingsRead.value ?? EMPTY_SETTINGS_TEXT,
		desiredEntries: desiredSettingsResult.value,
		ownershipRecords: settingRecords,
		mode: request.mode,
		backupPath: settingsBackupBase,
		messages,
	});
	if (!draftMerge.ok) return err(invalidSettings(draftMerge.error));
	const pluginRecords = readPluginRecords(records);
	const pluginPlansResult = await buildPluginPlans(runtime.fs, manifests, enabled, request.state.paths.hub, request.state.paths.repo, runtime.platform, pluginRecords, messages);
	if (!pluginPlansResult.ok) return pluginPlansResult;
	const assetEnvironment = {
		fs: runtime.assetFs,
		messages,
		now: () => runtime.clock.nowText(),
		boundaryPath: claudeHome,
	};
	const assetPlanned = await planAssets(assetEnvironment, buildAssetPlans(manifests, enabled, request.state, runtime),readAssetRecords(records));
	if (!assetPlanned.ok) return assetPlanned;
	const ruleFiles = [
		{ path: codexPath, content: assembled.codex },
		{ path: generatedPath, content: assembled.claude },
		{ path: claudePath, content: ensureClaudeImports(claudeRead.value ?? "") },
	];
	const ruleRead = (path: string) => readOptional(runtime, path, messages);
	const rulePorts = {
		read: ruleRead,
		write: async (path: string, content: string): Promise<Result<void>> => {
			const result = await atomicWrite(runtime.fs, path, content, messages);
			return result.ok ? ok(undefined) : result;
		},
		rename: async (from: string, to: string): Promise<Result<void>> => {
			try {
				await runtime.fs.rename(from, to);
				return ok(undefined);
			} catch (error) {
				return err(messages.failure.renameFailed(from, to, errorText(error)));
			}
		},
		clock: () => today,
		messages,
	};
	const rulePlanned = await planRuleFiles(ruleFiles, rulePorts);
	if (!rulePlanned.ok) return rulePlanned;

	// The claude CLI writes enabledPlugins into settings.json, so settings are read and merged after the plugins.
	const plugins = await applyPlugins({
		runner: { run: (command, args) => runtime.process.run(command, args) },
		claudeCommand: "claude",
		messages,
		writeProgress,
		pathExists: async (path) => (await runtime.fs.modifiedAt(path)) !== null,
		realPath: (path) => runtime.fs.resolveTarget(path),
	}, keepKnownDisabledPlugins(pluginPlansResult.value, pluginRecords), pluginRecords);
	if (!plugins.ok) return plugins;
	const settingsCurrent = await readOptional(runtime, settingsPath, messages);
	if (!settingsCurrent.ok) return settingsCurrent;
	const currentSettingsText = settingsCurrent.value ?? EMPTY_SETTINGS_TEXT;
	const settingsBackup = await chooseBackupPath(settingsBackupBase, hashText(currentSettingsText), async (path) => {
		const existing = await readOptional(runtime, path, messages);
		return existing.ok ? ok(existing.value === null ? null : hashText(existing.value)) : existing;
	}, messages);
	if (!settingsBackup.ok) return settingsBackup;
	const settingsMerge = mergeSettings({
		currentText: currentSettingsText,
		desiredEntries: desiredSettingsResult.value,
		ownershipRecords: settingRecords,
		mode: request.mode,
		backupPath: settingsBackup.value.path,
		messages,
	});
	if (!settingsMerge.ok) return err(invalidSettings(settingsMerge.error));

	const nextRecords: Record<string, string> = {};
	for (const [key, value] of Object.entries(records)) {
		if (!isRigRecordKey(key)) nextRecords[key] = value;
	}
	for (const record of settingsMerge.records) nextRecords[`${SETTINGS_RECORD_PREFIX}${record.id}`] = JSON.stringify(record);
	for (const [path, record] of Object.entries(assetPlanned.value.records)) nextRecords[`${ASSET_RECORD_PREFIX}${path}`] = JSON.stringify(record);
	for (const [id, record] of Object.entries(plugins.value.records)) nextRecords[`${PLUGIN_RECORD_PREFIX}${id}`] = JSON.stringify(record);

	const plannedEvents: PlannedEvent[] = [];
	for (const repair of assembled.repairs) {
		plannedEvents.push({ type: "block-restored", level: "warn", text: messages.apply.blockRestored(repair === "codex" ? codexPath : repair) });
	}
	for (const event of settingsMerge.events) plannedEvents.push({ type: event.type, level: event.level, text: event.text });
	for (const event of assetPlanned.value.events) {
		plannedEvents.push({ type: event.type, level: "warn", text: messages.apply.changedFileSaved(event.path) });
	}
	const events = [...leftoverEvents, ...planEvents(journalDependencies, plannedEvents)];

	const settingsWriteText = settingsMerge.changed ? settingsMerge.text : null;
	const operations = assetPlanned.value.operations;
	const hasFileOperations = settingsWriteText !== null || operations.backups.length > 0 || operations.writes.length > 0 ||
		operations.removals.length > 0 || rulePlanned.value.backups.length > 0 || rulePlanned.value.writes.length > 0;
	let journalWritten = false;
	if (hasFileOperations) {
		// Write ahead: what is about to be written and who owns it afterwards, before anything on disk changes.
		const journal = buildJournal({
			oldRecords: records,
			newRecords: nextRecords,
			assetOperations: operations,
			settingsPath,
			settingsText: settingsWriteText,
			events,
		});
		const saved = await saveState(runtime, { ...baseState, records, journal });
		if (!saved.ok) return saved;
		journalWritten = true;
	}

	const assetsExecuted = await executeAssetOperations(assetEnvironment, operations);
	if (!assetsExecuted.ok) return assetsExecuted;
	const changedFiles: string[] = [];
	if (settingsWriteText !== null) {
		if (settingsCurrent.value !== null && !settingsBackup.value.exists) {
			const backup = await atomicWrite(runtime.fs, settingsBackup.value.path, settingsCurrent.value, messages);
			if (!backup.ok) return backup;
		}
		const settingsWrite = await atomicWrite(runtime.fs, settingsPath, settingsWriteText, messages);
		if (!settingsWrite.ok) return settingsWrite;
		changedFiles.push(settingsPath);
	}
	const rulesExecuted = await executeRuleFilePlan(rulePlanned.value, rulePorts);
	if (!rulesExecuted.ok) return rulesExecuted;
	changedFiles.unshift(...rulePlanned.value.writes.map((write) => write.path));
	// Assets and agents written or removed are changed files too; a backup only ever accompanies a removal.
	changedFiles.push(...operations.writes.map((write) => write.path), ...operations.removals);

	// Events keep their ids and leave only after the final state is saved, so a repeated apply never sends one twice.
	const finalState: RigState = events.length > 0
		? { ...baseState, records: nextRecords, journal: { entries: [], always: {}, events } }
		: { ...baseState, records: nextRecords };
	if (journalWritten || persistedState === null || canonicalStateText(finalState) !== canonicalStateText(persistedState)) {
		const saved = await saveState(runtime, finalState);
		if (!saved.ok) return saved;
	}
	const emitted = await emitJournalEvents(journalDependencies, events);
	if (!emitted.ok) return emitted;
	const nextState: RigState = { ...baseState, records: nextRecords };
	if (events.length > 0) {
		const saved = await saveState(runtime, nextState);
		if (!saved.ok) return saved;
	}
	const { installed, updated, uninstalled, marketplacesAdded, marketplacesRemoved } = plugins.value;
	const pluginChanges: PluginChanges = { installed, updated, uninstalled, marketplacesAdded, marketplacesRemoved };
	return ok({ state: nextState, changedFiles, pluginChanges });
};

// Record order follows the manifest order, which does not change the meaning of a state.
const canonicalStateText = (state: RigState): string =>
	JSON.stringify({ ...state, records: Object.entries(state.records).sort(([left], [right]) => left.localeCompare(right)) });

const withoutJournal = (state: RigState): RigState => {
	const { journal: _journal, ...rest } = state;
	return rest;
};

const saveState = async (runtime: RuntimePorts, state: RigState): Promise<Result<void>> => {
	const messages = messagesFor(runtime.language);
	try {
		await runtime.fs.ensureDirectory(joinPath(runtime.home, ".agent-rig"));
	} catch (error) {
		return err(messages.failure.applyStateWriteFailed(errorText(error)));
	}
	const written = await writeState(runtime.fs, runtime.home, state, messages);
	return written.ok ? ok(undefined) : written;
};

const buildDesiredSettings = (
	manifests: readonly FeatureManifest[],
	enabled: ReadonlySet<string>,
	runtime: RuntimePorts,
	placeholders: Readonly<Record<string, string>>,
	mode: RigState["mode"],
	programs: HookPrograms,
): Result<DesiredSettingEntry[]> => {
	const messages = messagesFor(runtime.language);
	const entries: DesiredSettingEntry[] = mode === "server"
		? [{ id: UPDATE_CHANNEL_SETTING_ID, kind: "install-default", path: UPDATE_CHANNEL_PATH, value: SERVER_UPDATE_CHANNEL }]
		: [];
	for (const feature of manifests) {
		if (!enabled.has(feature.name) || !feature.platforms.includes(runtime.platform)) continue;
		for (const hook of feature.hooks) {
			if (hook.platform !== undefined && hook.platform !== runtime.platform) continue;
			const value = hookSettingValue(hook, placeholders, runtime.language, programs);
			if (!value.ok) return value;
			entries.push({
				id: `${feature.name}:hook:${hook.event}:${hook.matcher}:${hookScriptName(hook)}`,
				feature: feature.name,
				kind: "hook",
				event: hook.event,
				matcher: hook.matcher,
				scriptName: hookScriptName(hook),
				value: value.value,
			});
		}
		for (const setting of feature.settings) {
			if (setting.platform !== undefined && setting.platform !== runtime.platform) continue;
			const path = setting.path ?? setting.key.split(".");
			const settingValue = resolveJsonPlaceholders(setting.value, placeholders, `${feature.name} setting ${setting.key}`, messages);
			if (!settingValue.ok) return settingValue;
			// The id names the setting by its key and, for a list, by the entry. A manifest position is not part of it,
			// so reordering or inserting a setting never changes who owns which value.
			const baseId = setting.id ?? `${feature.name}:setting:${setting.key}`;
			if (setting.kind === "install-default") {
				entries.push({ id: baseId, kind: "install-default", path, value: settingValue.value });
			} else if (setting.kind === "list-entry" || (setting.kind === undefined && isListSetting(path))) {
				if (typeof settingValue.value !== "string") return err(messages.failure.settingNotStringListEntry(feature.name, setting.key));
				entries.push({ id: setting.id ?? `${baseId}:${settingValue.value}`, feature: feature.name, kind: "list-entry", path, value: settingValue.value });
			} else {
				entries.push({ id: baseId, feature: feature.name, kind: "value", path, value: settingValue.value });
			}
		}
	}
	return ok(entries);
};

const hookSettingValue = (
	hook: HookManifest,
	placeholders: Readonly<Record<string, string>>,
	language: Language,
	programs: HookPrograms,
): Result<JsonObject> => {
	const messages = messagesFor(language);
	const command = resolvePlaceholders(resolvedHookCommand(hook.command, programs, hook.args !== undefined, hook.shell), placeholders, `${hook.event} hook command`, messages);
	if (!command.ok) return command;
	const value: JsonObject = { type: "command", command: command.value };
	if (hook.args !== undefined) {
		const args: string[] = [];
		for (const [index, argument] of hook.args.entries()) {
			const resolved = resolvePlaceholders(argument, placeholders, `${hook.event} hook arg ${index}`, messages);
			if (!resolved.ok) return resolved;
			args.push(resolved.value);
		}
		value.args = args;
	}
	if (hook.timeout !== undefined) value.timeout = hook.timeout;
	// A hook with a status message but no translation for the language keeps the English text.
	const translated = isTranslatedLanguage(language) ? hook.translations?.[language]?.statusMessage : undefined;
	if (hook.statusMessage !== undefined) value.statusMessage = translated ?? hook.statusMessage;
	if (hook.async !== undefined) value.async = hook.async;
	if (hook.asyncRewake !== undefined) value.asyncRewake = hook.asyncRewake;
	if (hook.shell !== undefined) value.shell = hook.shell;
	return ok(value);
};

const hookScriptName = (hook: HookManifest): string => {
	const script = hook.args?.find((argument) => /\.(?:py|sh|ps1)(?:$|["'])/.test(argument));
	if (script === undefined) return hook.command;
	const normalized = script.replaceAll("\\", "/").replaceAll('"', "");
	return normalized.slice(normalized.lastIndexOf("/") + 1);
};

const buildAssetPlans = (
	manifests: readonly FeatureManifest[],
	enabled: ReadonlySet<string>,
	state: RigState,
	runtime: RuntimePorts,
): AssetPlan[] => manifests.map((feature) => ({
	enabled: feature.name === "base" || (enabled.has(feature.name) && feature.platforms.includes(runtime.platform)),
	clonePath: state.paths.repo,
	pythonPath: runtime.pythonCommand,
	homePath: runtime.home,
	hubPath: state.paths.hub,
	files: [
		...feature.agents.map((sourcePath) => makeAssetFile(state.paths.repo, feature.name, sourcePath, runtime.home, AGENT_SOURCE_PREFIX, "agents")),
		...feature.skills.map((sourcePath) => makeAssetFile(state.paths.repo, feature.name, sourcePath, runtime.home, SKILL_SOURCE_PREFIX, "skills")),
		...(feature.assets ?? []).map((asset) => makeManifestAsset(state.paths.repo, feature.name, asset, runtime.home)),
	],
}));

const loadRuleChunks = async (
	runtime: RuntimePorts,
	manifests: readonly FeatureManifest[],
	enabled: ReadonlySet<string>,
	platform: RuntimePorts["platform"],
	repoPath: string,
	placeholders: Readonly<Record<string, string>>,
): Promise<Result<Array<{ target: "shared" | "claude"; text: string }>>> => {
	const messages = messagesFor(runtime.language);
	const chunks: Array<{ target: "shared" | "claude"; text: string }> = [];
	for (const feature of manifests) {
		if (!enabled.has(feature.name) || !feature.platforms.includes(platform)) continue;
		for (const rule of feature.rules) {
			if ((rule.platform !== undefined && rule.platform !== platform) ||
				!(rule.whenEnabled ?? []).every((name) => enabled.has(name)) ||
				!(rule.whenDisabled ?? []).every((name) => !enabled.has(name))) continue;
			const partDirectory = feature.name === "base"
				? joinPath(repoPath, "base")
				: joinPath(repoPath, "features", feature.name);
			const rulePath = joinPath(partDirectory, ...rule.path.replaceAll("\\", "/").split("/"));
			let text: string;
			try {
				text = await runtime.fs.readText(rulePath);
			} catch (error) {
				return err(messages.failure.ruleChunkReadFailed(rulePath, errorText(error)));
			}
			const resolved = resolvePlaceholders(text, placeholders, rulePath, messages);
			if (!resolved.ok) return resolved;
			chunks.push({ target: rule.target, text: resolved.value });
		}
	}
	return ok(chunks);
};

const makeManifestAsset = (repoPath: string, featureName: string, asset: AssetManifest, homePath: string) => ({
	sourcePath: joinPath(repoPath, featureName === "base" ? "base" : "features", ...(featureName === "base" ? [] : [featureName]), asset.sourcePath),
	targetPath: joinPath(homePath, ".claude", asset.targetPath),
});

const makeAssetFile = (
	repoPath: string,
	featureName: string,
	sourcePath: string,
	homePath: string,
	prefix: string,
	targetFolder: string,
) => {
	const normalized = sourcePath.replaceAll("\\", "/");
	const targetRelative = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
	return {
		sourcePath: joinPath(repoPath, featureName === "base" ? "base" : "features", ...(featureName === "base" ? [] : [featureName]), normalized),
		targetPath: joinPath(homePath, ".claude", targetFolder, targetRelative),
	};
};

// A plugin written without "@" is local: "rig:<folder>" is a folder of the rig clone under plugins/, anything else comes
// from the hub. A local folder declares its marketplace name in its own manifest, which is read at most once per apply
// and only when such a plugin is enabled.
const buildPluginPlans = async (
	fs: FileSystem,
	manifests: readonly FeatureManifest[],
	enabled: ReadonlySet<string>,
	hubPath: string,
	repoPath: string,
	platform: RuntimePorts["platform"],
	pluginRecords: Readonly<Record<string, PluginRecord>>,
	messages: Messages,
): Promise<Result<PluginPlan[]>> => {
	const plans: PluginPlan[] = [];
	const marketplaces = new Map<string, Result<MarketplaceManifest>>();
	for (const feature of manifests) {
		for (const plugin of feature.plugins) {
			const isEnabled = feature.name === "base" ? true : enabled.has(feature.name) && feature.platforms.includes(platform);
			const local = localPluginOrigin(plugin, hubPath, repoPath);
			if (local !== null) {
				if (!isEnabled) {
					plans.push(...recordedLocalPlans(local.name, local.path, pluginRecords));
					continue;
				}
				const cached = marketplaces.get(local.path);
				const manifest = cached ?? await readMarketplaceManifest(fs, local.path, local.label, messages);
				marketplaces.set(local.path, manifest);
				if (!manifest.ok) return manifest;
				if (local.mustBeListed && !manifest.value.plugins.includes(local.name)) {
					return err(messages.failure.pluginNotListed(messages.failure.marketplaceLabel(local.label), manifestPathOf(local.path), local.name));
				}
				plans.push({ enabled: true, id: `${local.name}@${manifest.value.name}`, marketplace: manifest.value.name, source: local.path });
				continue;
			}
			const marketplace = plugin.slice(plugin.indexOf("@") + 1);
			const source = marketplaceSource(marketplace);
			if (source === null) return err(messages.failure.pluginUnknownMarketplace(plugin, marketplace));
			plans.push({ enabled: isEnabled, id: plugin, marketplace, source });
		}
	}
	return ok(plans);
};

type LocalPluginOrigin = { name: string; path: string; label: "rig-plugin" | "hub"; mustBeListed: boolean };

export const localPluginOrigin = (plugin: string, hubPath: string, repoPath: string): LocalPluginOrigin | null => {
	if (plugin.startsWith(RIG_PLUGIN_PREFIX)) {
		const folder = plugin.slice(RIG_PLUGIN_PREFIX.length);
		return { name: folder, path: joinPath(repoPath, RIG_PLUGINS_DIRECTORY, folder), label: "rig-plugin", mustBeListed: true };
	}
	if (plugin.includes("@")) return null;
	return { name: plugin, path: hubPath, label: "hub", mustBeListed: false };
};

// A disabled local plugin is not looked up again: its recorded ids are uninstalled under the names they were installed with.
const recordedLocalPlans = (plugin: string, sourcePath: string, pluginRecords: Readonly<Record<string, PluginRecord>>): PluginPlan[] =>
	Object.entries(pluginRecords)
		.filter(([id, record]) => id.startsWith(`${plugin}@`) && record.source === sourcePath)
		.map(([id, record]) => ({ enabled: false, id, marketplace: record.marketplace, source: record.source }));

type MarketplaceManifest = { name: string; plugins: string[] };

const manifestPathOf = (directory: string): string => joinPath(directory, MARKETPLACE_DIRECTORY, MARKETPLACE_FILENAME);

export const readMarketplaceManifest = async (fs: FileSystem, directory: string, kind: "rig-plugin" | "hub", messages: Messages): Promise<Result<MarketplaceManifest>> => {
	const label = messages.failure.marketplaceLabel(kind);
	const path = manifestPathOf(directory);
	let text: string;
	try {
		text = await fs.readText(path);
	} catch (error) {
		return err(messages.failure.marketplaceReadFailed(label, path, errorText(error)));
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return err(messages.failure.marketplaceInvalidJson(label, path));
	}
	if (!isMarketplaceName(value)) return err(messages.failure.marketplaceNoName(label, path));
	const listed: unknown[] = Array.isArray(value.plugins) ? value.plugins : [];
	const plugins = listed.flatMap((entry) => (isObject(entry) && typeof entry.name === "string" ? [entry.name] : []));
	return ok({ name: value.name, plugins });
};

const isMarketplaceName = (value: unknown): value is { name: string; plugins?: unknown } =>
	isObject(value) && typeof value.name === "string" && value.name.length > 0;

const marketplaceSource = (marketplace: string): string | null => {
	if (marketplace === "claude-plugins-official") return CLAUDE_PLUGINS_OFFICIAL_SOURCE;
	if (marketplace === "openai-codex") return OPENAI_CODEX_SOURCE;
	return null;
};

const keepKnownDisabledPlugins = (plans: readonly PluginPlan[], records: Readonly<Record<string, PluginRecord>>): PluginPlan[] => {
	const knownIds = new Set(Object.keys(records));
	return plans.filter((plan) => plan.enabled || knownIds.has(plan.id));
};

const isListSetting = (path: readonly string[]): boolean => {
	const key = path.join(".");
	return key === "permissions.allow" || key === "permissions.deny" || key === "autoMode.allow";
};

const parseSettingRecords = (records: Record<string, string>): unknown[] => {
	const values: unknown[] = [];
	for (const [key, text] of Object.entries(records)) {
		if (!key.startsWith(SETTINGS_RECORD_PREFIX)) continue;
		try {
			values.push(JSON.parse(text));
		} catch {
			values.push(null);
		}
	}
	return values;
};

const readAssetRecords = (records: Record<string, string>): Record<string, AssetRecord> => parsePrefixedRecords(records, ASSET_RECORD_PREFIX, isAssetRecord);
const readPluginRecords = (records: Record<string, string>): Record<string, PluginRecord> => parsePrefixedRecords(records, PLUGIN_RECORD_PREFIX, isPluginRecord);

const parsePrefixedRecords = <T>(records: Record<string, string>, prefix: string, validate: (value: unknown) => value is T): Record<string, T> => {
	const parsed: Record<string, T> = {};
	for (const [key, text] of Object.entries(records)) {
		if (!key.startsWith(prefix)) continue;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			continue;
		}
		if (validate(value)) parsed[key.slice(prefix.length)] = value;
	}
	return parsed;
};

const isAssetRecord = (value: unknown): value is AssetRecord => isObject(value) && typeof value.hash === "string" &&
	typeof value.owned === "boolean" && Array.isArray(value.notifiedHashes) && value.notifiedHashes.every((hash) => typeof hash === "string");

const isPluginRecord = (value: unknown): value is PluginRecord => isObject(value) && typeof value.enabled === "boolean" &&
	typeof value.marketplace === "string" && typeof value.source === "string";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const readOptional = async (runtime: RuntimePorts, path: string, messages: Messages): Promise<Result<string | null>> => {
	try {
		return ok(await runtime.fs.readText(path));
	} catch (error) {
		if (isNotFound(error)) return ok(null);
		return err(messages.failure.readFailed(path, errorText(error)));
	}
};

const isNotFound = (error: unknown): boolean => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
