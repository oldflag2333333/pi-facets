import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	LoadedProfile,
	ProfileCatalog,
	ProfileDefinition,
	ProfileDiagnostic,
	ProfileSource,
	ResolvedProfile,
} from "./types.js";

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PROFILE_BYTES = 256 * 1024;
const ALLOWED_KEYS = new Set([
	"version",
	"name",
	"description",
	"model",
	"thinkingLevel",
	"tools",
	"skills",
	"instructions",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown, maxItems: number): value is string[] {
	return Array.isArray(value) && value.length <= maxItems
		&& value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 4096);
}

function parseProfile(value: unknown, sourcePath: string): ProfileDefinition {
	if (!isRecord(value)) throw new Error("profile must be a JSON object");
	const unknownKeys = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
	if (unknownKeys.length > 0) throw new Error(`unknown fields: ${unknownKeys.join(", ")}`);
	if (value.version !== 1) throw new Error("version must be 1");
	if (typeof value.name !== "string" || !PROFILE_NAME.test(value.name)) {
		throw new Error("name must be 1-64 characters using letters, numbers, dot, underscore, or hyphen");
	}
	if (!stringArray(value.tools, 128) || value.tools.length === 0) throw new Error("tools must be a non-empty string array with at most 128 entries");
	if (value.skills !== undefined && !stringArray(value.skills, 128)) throw new Error("skills must be a string array with at most 128 entries");
	for (const key of ["description", "model", "thinkingLevel", "instructions"] as const) {
		if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].trim().length === 0)) {
			throw new Error(`${key} must be a non-empty string`);
		}
	}
	if (typeof value.description === "string" && value.description.length > 1024) throw new Error("description exceeds 1024 characters");
	if (typeof value.model === "string" && value.model.length > 512) throw new Error("model exceeds 512 characters");
	if (typeof value.thinkingLevel === "string" && value.thinkingLevel.length > 128) throw new Error("thinkingLevel exceeds 128 characters");
	if (typeof value.instructions === "string" && value.instructions.length > 64 * 1024) throw new Error("instructions exceeds 65536 characters");
	const stem = path.basename(sourcePath, path.extname(sourcePath));
	if (stem !== value.name) throw new Error(`name '${value.name}' must match filename '${stem}.json'`);
	return {
		version: 1,
		name: value.name,
		tools: [...new Set(value.tools)],
		...(typeof value.description === "string" ? { description: value.description } : {}),
		...(typeof value.model === "string" ? { model: value.model } : {}),
		...(typeof value.thinkingLevel === "string" ? { thinkingLevel: value.thinkingLevel } : {}),
		...(Array.isArray(value.skills) ? { skills: [...new Set(value.skills as string[])] } : {}),
		...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
	};
}

function loadDirectory(directory: string, source: ProfileSource, diagnostics: ProfileDiagnostic[]): Map<string, LoadedProfile> {
	const profiles = new Map<string, LoadedProfile>();
	let names: string[];
	try {
		names = fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return profiles;
		diagnostics.push({ path: directory, message: String(error) });
		return profiles;
	}
	for (const name of names) {
		const sourcePath = path.join(directory, name);
		try {
			if (fs.statSync(sourcePath).size > MAX_PROFILE_BYTES) throw new Error(`profile exceeds ${MAX_PROFILE_BYTES} bytes`);
			const parsed = parseProfile(JSON.parse(fs.readFileSync(sourcePath, "utf8")) as unknown, sourcePath);
			profiles.set(parsed.name, { ...parsed, source, sourcePath });
		} catch (error) {
			diagnostics.push({ path: sourcePath, message: error instanceof Error ? error.message : String(error) });
		}
	}
	return profiles;
}

export function globalProfilesDir(): string {
	return path.join(getAgentDir(), "facets", "profiles");
}

export function projectProfilesDir(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "facets", "profiles");
}

export function loadProfiles(cwd: string, includeProject: boolean): ProfileCatalog {
	const diagnostics: ProfileDiagnostic[] = [];
	const profiles = loadDirectory(globalProfilesDir(), "global", diagnostics);
	if (includeProject) {
		const projectDir = projectProfilesDir(cwd);
		const diagnosticStart = diagnostics.length;
		const projectProfiles = loadDirectory(projectDir, "project", diagnostics);
		for (const diagnostic of diagnostics.slice(diagnosticStart)) {
			if (path.dirname(diagnostic.path) === projectDir && diagnostic.path.endsWith(".json")) {
				profiles.delete(path.basename(diagnostic.path, ".json"));
			}
		}
		for (const [name, profile] of projectProfiles) profiles.set(name, profile);
	}
	return { profiles, diagnostics };
}

function expandHome(value: string): string {
	return value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function skillCandidate(candidate: string): string | undefined {
	try {
		const stat = fs.statSync(candidate);
		if (stat.isFile()) return candidate;
		if (stat.isDirectory()) {
			const entry = path.join(candidate, "SKILL.md");
			if (fs.statSync(entry).isFile()) return entry;
		}
	} catch {}
	return undefined;
}

function resolveSkill(reference: string, profile: LoadedProfile, cwd: string): string {
	const expanded = expandHome(reference);
	const looksLikePath = path.isAbsolute(expanded) || expanded.startsWith(".") || expanded.includes("/") || expanded.includes("\\");
	const candidates = looksLikePath
		? [path.resolve(path.dirname(profile.sourcePath), expanded)]
		: [
			path.join(getAgentDir(), "skills", expanded),
			path.join(os.homedir(), ".agents", "skills", expanded),
			path.join(cwd, CONFIG_DIR_NAME, "skills", expanded),
			path.join(cwd, ".agents", "skills", expanded),
		];
	for (const candidate of candidates) {
		const resolved = skillCandidate(candidate) ?? skillCandidate(`${candidate}.md`);
		if (resolved) return path.resolve(resolved);
	}
	throw new Error(`Profile '${profile.name}' references unknown skill '${reference}'.`);
}

export function resolveProfile(name: string, cwd: string, includeProject: boolean): ResolvedProfile {
	const catalog = loadProfiles(cwd, includeProject);
	const invalid = catalog.diagnostics.map((item) => `${item.path}: ${item.message}`);
	const profile = catalog.profiles.get(name);
	if (!profile) {
		const available = [...catalog.profiles.keys()].sort().join(", ") || "(none)";
		const suffix = invalid.length > 0 ? ` Invalid profiles: ${invalid.join("; ")}` : "";
		throw new Error(`Unknown Facets profile '${name}'. Available: ${available}.${suffix}`);
	}
	return {
		...profile,
		resolvedSkills: (profile.skills ?? []).map((skill) => resolveSkill(skill, profile, cwd)),
		resolvedExtensions: [],
	};
}
