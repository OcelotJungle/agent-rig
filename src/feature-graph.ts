import type { FeatureManifest, Platform } from "./feature.js";
import type { FileSystem } from "./file-system.js";
import type { Result } from "./result.js";

import { readFeature } from "./feature.js";
import { joinPath } from "./file-system.js";
import { err, errorText, ok } from "./result.js";

export type FeatureChange = {
	features: FeatureManifest[];
	enabled: string[];
	name: string;
	action: "enable" | "disable";
	platform: Platform;
};

export const validateFeatureGraph = (features: FeatureManifest[]): Result<void> => {
	const byName = new Map<string, FeatureManifest>();
	for (const feature of features) byName.set(feature.name, feature);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	for (const feature of features) {
		for (const dependency of feature.dependencies) {
			if (!byName.has(dependency)) return err(`Feature ${feature.name} depends on missing feature ${dependency}`);
		}
		for (const rule of feature.rules) {
			for (const condition of [...(rule.whenEnabled ?? []), ...(rule.whenDisabled ?? [])]) {
				if (!byName.has(condition)) return err(`Feature ${feature.name} rule depends on missing feature ${condition}`);
			}
		}
	}
	const visit = (name: string): string | null => {
		if (visiting.has(name)) return name;
		if (visited.has(name)) return null;
		visiting.add(name);
		const feature = byName.get(name);
		if (feature !== undefined) {
			for (const dependency of feature.dependencies) {
				const cycle = visit(dependency);
				if (cycle !== null) return cycle;
			}
		}
		visiting.delete(name);
		visited.add(name);
		return null;
	};
	for (const feature of features) {
		const cycle = visit(feature.name);
		if (cycle !== null) return err(`Feature dependency cycle includes ${cycle}`);
	}
	return ok(undefined);
};

export const loadFeatures = async (fs: FileSystem, repoPath: string): Promise<Result<FeatureManifest[]>> => {
	const base = await readFeature(fs, joinPath(repoPath, "base"));
	if (!base.ok) return base;
	if (base.value.name !== "base") return err(`Base manifest must be named base, found ${base.value.name}`);
	try {
		const entries = await fs.listDirectory(joinPath(repoPath, "features"));
		const directories = entries.filter((entry) => entry.directory).sort((left, right) => left.name.localeCompare(right.name));
		const features: FeatureManifest[] = [base.value];
		for (const entry of directories) {
			const feature = await readFeature(fs, joinPath(repoPath, "features", entry.name));
			if (!feature.ok) return feature;
			if (feature.value.name !== entry.name) return err(`Feature directory ${entry.name} contains manifest for ${feature.value.name}`);
			features.push(feature.value);
		}
		const duplicate = features.find((feature, index) => features.findIndex((candidate) => candidate.name === feature.name) !== index);
		if (duplicate !== undefined) return err(`Duplicate feature name ${duplicate.name}`);
		const graph = validateFeatureGraph(features);
		return graph.ok ? ok(features) : graph;
	} catch (error) {
		return err(`Could not load features: ${errorText(error)}`);
	}
};

export const resolveFeatureChange = (change: FeatureChange): Result<string[]> => {
	const graph = validateFeatureGraph(change.features);
	if (!graph.ok) return graph;
	const byName = new Map<string, FeatureManifest>();
	for (const feature of change.features) byName.set(feature.name, feature);
	const selected = byName.get(change.name);
	if (selected === undefined) return err(`Unknown feature ${change.name}`);
	if (change.action === "enable") {
		if (!selected.platforms.includes(change.platform)) return err(`Feature ${selected.name} is available only on ${selected.platforms.map((platform) => platform === "windows" ? "Windows" : platform).join(", ")}`);
		for (const dependency of selected.dependencies) {
			if (!change.enabled.includes(dependency)) return err(`Enable feature ${dependency} before ${selected.name}`);
			const dependencyFeature = byName.get(dependency);
			if (dependencyFeature !== undefined && !dependencyFeature.platforms.includes(change.platform)) return err(`Feature ${dependency} required by ${selected.name} is unavailable on ${change.platform}`);
		}
		return ok([...new Set([...change.enabled, selected.name])]);
	}
	const dependent = change.features.find((feature) => change.enabled.includes(feature.name) && feature.dependencies.includes(selected.name));
	if (dependent !== undefined) return err(`Cannot disable ${selected.name}; enabled feature ${dependent.name} depends on it`);
	return ok(change.enabled.filter((name) => name !== selected.name));
};
