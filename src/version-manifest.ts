export const VERSION_PATHS = { rig: "package.json", hub: "plugin/package.json" } as const;

const isVersionManifest = (value: unknown): value is { version: string } =>
	typeof value === "object" && value !== null && !Array.isArray(value) &&
	"version" in value && typeof value.version === "string";

// A broken or versionless manifest is not an error: the caller then shows the commit alone.
export const parseVersion = (text: string): string | null => {
	try {
		const value: unknown = JSON.parse(text);
		return isVersionManifest(value) ? value.version : null;
	} catch {
		return null;
	}
};
