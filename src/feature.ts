import type { FileSystem } from "./file-system.js";
import type { TranslatedLanguage } from "./messages.js";
import type { Result } from "./result.js";

import { joinPath } from "./file-system.js";
import { isTranslatedLanguage } from "./messages.js";
import { err, errorText, ok } from "./result.js";

const REQUIRED_LISTS = [
	"platforms",
	"dependencies",
	"rules",
	"hooks",
	"settings",
	"plugins",
	"files",
	"agents",
	"skills",
	"hubCommands",
	"programs",
] as const;

export type Platform = "linux" | "windows" | "darwin";
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type RuleChunk = {
	target: "shared" | "claude";
	path: string;
	platform?: Platform;
	whenEnabled?: string[];
	whenDisabled?: string[];
};
export type HookManifest = {
	event: string;
	matcher: string;
	command: string;
	platform?: Platform;
	args?: string[];
	timeout?: number;
	/** English text. It stays a plain string: the previous release reads new manifests during `rig update`. */
	statusMessage?: string;
	/** Status messages in the other languages, keyed by language. A missing language falls back to `statusMessage`. */
	translations?: Partial<Record<TranslatedLanguage, { statusMessage: string }>>;
	async?: boolean;
	asyncRewake?: boolean;
	shell?: string;
};
export type SettingManifest = {
	id?: string;
	key: string;
	/** Explicit settings path; use it when a key segment contains a dot. Defaults to key split on dots. */
	path?: string[];
	value: JsonValue;
	platform?: Platform;
	kind?: "value" | "list-entry" | "install-default";
};
export type AssetManifest = { sourcePath: string; targetPath: string };
export type ProgramManifest = { name: string; command: string; installCommand: string | null; systemPackage: boolean; platform?: Platform };
export type FeatureManifest = {
	name: string;
	/** English text. It stays a plain string: the previous release reads new manifests during `rig update`. */
	description: string;
	/** Texts in the other languages, keyed by language. A missing language falls back to the English text. */
	translations?: Partial<Record<TranslatedLanguage, { description: string }>>;
	enabledByDefault: boolean;
	platforms: Platform[];
	dependencies: string[];
	rules: RuleChunk[];
	hooks: HookManifest[];
	settings: SettingManifest[];
	plugins: string[];
	files: string[];
	assets?: AssetManifest[];
	agents: string[];
	skills: string[];
	hubCommands: string[];
	programs: ProgramManifest[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] => isUnknownArray(value) && value.every(isString);
const isRelativePathArray = (value: unknown): value is string[] => isUnknownArray(value) &&
	value.every((entry) => isString(entry) && isRelativeAssetPath(entry));
const isPlatform = (value: unknown): value is Platform => value === "linux" || value === "windows" || value === "darwin";
const isRule = (value: unknown): value is RuleChunk => isObject(value) &&
	(value.target === "shared" || value.target === "claude") && isString(value.path) && isRelativeAssetPath(value.path) &&
	(value.platform === undefined || isPlatform(value.platform)) &&
	(value.whenEnabled === undefined || isStringArray(value.whenEnabled)) &&
	(value.whenDisabled === undefined || isStringArray(value.whenDisabled));
// A language this release does not know is ignored, so a manifest with a newer translation still loads.
const isTranslatedTexts = (value: unknown, key: "description" | "statusMessage"): boolean => isObject(value) &&
	Object.entries(value).every(([language, text]) => !isTranslatedLanguage(language) || (isObject(text) && isString(text[key])));
const isHook = (value: unknown): value is HookManifest => isObject(value) &&
	(value.translations === undefined || isTranslatedTexts(value.translations, "statusMessage")) &&
	isString(value.event) && isString(value.matcher) && isString(value.command) &&
	(value.platform === undefined || isPlatform(value.platform)) &&
	(value.args === undefined || isStringArray(value.args)) &&
	(value.timeout === undefined || (typeof value.timeout === "number" && Number.isFinite(value.timeout))) &&
	(value.statusMessage === undefined || isString(value.statusMessage)) &&
	(value.async === undefined || typeof value.async === "boolean") &&
	(value.asyncRewake === undefined || typeof value.asyncRewake === "boolean") &&
	(value.shell === undefined || isString(value.shell));
const isJsonValue = (value: unknown): value is JsonValue => {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (isUnknownArray(value)) return value.every(isJsonValue);
	return isObject(value) && Object.values(value).every(isJsonValue);
};
const isSetting = (value: unknown): value is SettingManifest => isObject(value) && isString(value.key) && (value.path === undefined || (isStringArray(value.path) && value.path.length > 0)) &&
	isJsonValue(value.value) && (value.id === undefined || isString(value.id)) &&
	(value.platform === undefined || isPlatform(value.platform)) &&
	(value.kind === undefined || value.kind === "value" || value.kind === "list-entry" || value.kind === "install-default");
const isAsset = (value: unknown): value is AssetManifest => isObject(value) && isString(value.sourcePath) &&
	isRelativeAssetPath(value.sourcePath) && isString(value.targetPath) && isRelativeAssetPath(value.targetPath);
const isProgram = (value: unknown): value is ProgramManifest => isObject(value) && isString(value.name) &&
	isString(value.command) && (value.installCommand === null || isString(value.installCommand)) && typeof value.systemPackage === "boolean" &&
	(value.platform === undefined || isPlatform(value.platform));
const isRelativeAssetPath = (value: string): boolean => {
	const normalized = value.replaceAll("\\", "/");
	return normalized.length > 0 && !normalized.startsWith("/") && !/^[A-Za-z]:/.test(normalized) &&
		!normalized.split("/").some((part) => part === ".." || part.length === 0);
};

const hasValidLists = (value: Record<string, unknown>): boolean => {
	if (!isStringArray(value.dependencies) || !isUnknownArray(value.platforms) || !value.platforms.every(isPlatform) ||
		!isUnknownArray(value.rules) || !value.rules.every(isRule) || !isUnknownArray(value.hooks) || !value.hooks.every(isHook) ||
		!isUnknownArray(value.settings) || !value.settings.every(isSetting) || !isStringArray(value.plugins) ||
		!isRelativePathArray(value.files) ||
		!isRelativePathArray(value.agents) || !isRelativePathArray(value.skills) || !isStringArray(value.hubCommands) ||
		!isUnknownArray(value.programs) || !value.programs.every(isProgram) ||
		(value.assets !== undefined && (!isUnknownArray(value.assets) || !value.assets.every(isAsset)))) return false;
	return REQUIRED_LISTS.every((key) => key in value);
};

const isFeatureManifest = (value: unknown): value is FeatureManifest => isObject(value) &&
	isString(value.name) && /^[a-z0-9][a-z0-9-]*$/.test(value.name) && isString(value.description) &&
	(value.translations === undefined || isTranslatedTexts(value.translations, "description")) && typeof value.enabledByDefault === "boolean" && hasValidLists(value);

export const validateFeature = (value: unknown): Result<FeatureManifest> => {
	const name = isObject(value) && isString(value.name) ? value.name : "<unknown>";
	if (!isFeatureManifest(value)) {
		return err(`Feature ${name} has an invalid feature.json manifest`);
	}
	return ok(value);
};

export const readFeature = async (fs: FileSystem, directory: string): Promise<Result<FeatureManifest>> => {
	try {
		const text = await fs.readText(joinPath(directory, "feature.json"));
		let data: unknown;
		try {
			data = JSON.parse(text);
		} catch {
			return err(`Feature at ${directory} has invalid JSON in feature.json`);
		}
		const result = validateFeature(data);
		return result.ok ? result : err(`${directory}: ${result.error}`);
	} catch (error) {
		return err(`Could not load feature at ${directory}: ${errorText(error)}`);
	}
};
