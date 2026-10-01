import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { materializeProfileSkill } from "./skill-visibility.js";
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
const MAX_SYSTEM_PROMPT_BYTES = 256 * 1024;
const PROFILE_CONFIG_FILE = "config.json";
const PROFILE_SYSTEM_PROMPT_FILE = "SYSTEM.md";
const ALLOWED_KEYS = new Set([
	"version",
	"name",
	"description",
	"model",
	"thinkingLevel",
	"sessionPersistence",
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

function parseProfile(value: unknown, expectedName: string): ProfileDefinition {
	if (!isRecord(value)) throw new Error("profile must be a JSON object");
	const unknownKeys = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
	if (unknownKeys.length > 0) throw new Error(`unknown fields: ${unknownKeys.join(", ")}`);
	if (value.version !== 1) throw new Error("version must be 1");
	if (typeof value.name !== "string" || !PROFILE_NAME.test(value.name)) {
		throw new Error("name must be 1-64 characters using letters, numbers, dot, underscore, or hyphen");
	}
	if (!stringArray(value.tools, 128) || value.tools.length === 0) throw new Error("tools must be a non-empty string array with at most 128 entries");
	if (value.skills !== undefined && !stringArray(value.skills, 128)) throw new Error("skills must be a string array with at most 128 entries");
	if (value.sessionPersistence !== undefined && value.sessionPersistence !== "ephemeral" && value.sessionPersistence !== "persistent") {
		throw new Error("sessionPersistence must be 'ephemeral' or 'persistent'");
	}
	for (const key of ["description", "model", "thinkingLevel", "instructions"] as const) {
		if (value[key] !== undefined && (typeof value[key] !== "string" || value[key].trim().length === 0)) {
			throw new Error(`${key} must be a non-empty string`);
		}
	}
	if (typeof value.description === "string" && value.description.length > 1024) throw new Error("description exceeds 1024 characters");
	if (typeof value.model === "string" && value.model.length > 512) throw new Error("model exceeds 512 characters");
	if (typeof value.thinkingLevel === "string" && value.thinkingLevel.length > 128) throw new Error("thinkingLevel exceeds 128 characters");
	if (typeof value.instructions === "string" && value.instructions.length > 64 * 1024) throw new Error("instructions exceeds 65536 characters");
	if (expectedName !== value.name) throw new Error(`name '${value.name}' must match profile entry '${expectedName}'`);
	return {
		version: 1,
		name: value.name,
		tools: [...new Set(value.tools)],
		...(typeof value.description === "string" ? { description: value.description } : {}),
		...(typeof value.model === "string" ? { model: value.model } : {}),
		...(typeof value.thinkingLevel === "string" ? { thinkingLevel: value.thinkingLevel } : {}),
		...(value.sessionPersistence === "ephemeral" || value.sessionPersistence === "persistent"
			? { sessionPersistence: value.sessionPersistence }
			: {}),
		...(Array.isArray(value.skills) ? { skills: [...new Set(value.skills as string[])] } : {}),
		...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
	};
}

interface ProfileCandidate {
	name: string;
	configPath: string;
	directoryPath?: string;
}

interface LoadedProfileDirectory {
	profiles: Map<string, LoadedProfile>;
	invalidNames: Set<string>;
}

function readSystemPrompt(directoryPath: string): string | undefined {
	const systemPromptPath = path.join(directoryPath, PROFILE_SYSTEM_PROMPT_FILE);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(systemPromptPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	if (!stat.isFile()) throw new Error(`${PROFILE_SYSTEM_PROMPT_FILE} must be a regular file`);
	if (stat.size > MAX_SYSTEM_PROMPT_BYTES) {
		throw new Error(`${PROFILE_SYSTEM_PROMPT_FILE} exceeds ${MAX_SYSTEM_PROMPT_BYTES} bytes`);
	}
	const content = fs.readFileSync(systemPromptPath, "utf8").replace(/^\uFEFF/, "");
	if (!content.trim()) throw new Error(`${PROFILE_SYSTEM_PROMPT_FILE} must not be empty`);
	return content;
}

function loadDirectory(directory: string, source: ProfileSource, diagnostics: ProfileDiagnostic[]): LoadedProfileDirectory {
	const profiles = new Map<string, LoadedProfile>();
	const invalidNames = new Set<string>();
	let entryNames: string[];
	try {
		entryNames = fs.readdirSync(directory).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { profiles, invalidNames };
		diagnostics.push({ path: directory, message: String(error) });
		return { profiles, invalidNames };
	}

	const candidates = new Map<string, ProfileCandidate[]>();
	for (const entryName of entryNames) {
		const entryPath = path.join(directory, entryName);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(entryPath);
		} catch (error) {
			diagnostics.push({ path: entryPath, message: error instanceof Error ? error.message : String(error) });
			continue;
		}
		let candidate: ProfileCandidate | undefined;
		if (stat.isFile() && entryName.endsWith(".json")) {
			candidate = { name: path.basename(entryName, ".json"), configPath: entryPath };
		} else if (stat.isDirectory()) {
			candidate = {
				name: entryName,
				configPath: path.join(entryPath, PROFILE_CONFIG_FILE),
				directoryPath: entryPath,
			};
		}
		if (!candidate) continue;
		const entries = candidates.get(candidate.name) ?? [];
		entries.push(candidate);
		candidates.set(candidate.name, entries);
	}

	for (const [name, matches] of candidates) {
		if (!PROFILE_NAME.test(name)) {
			invalidNames.add(name);
			diagnostics.push({ path: matches[0]!.configPath, message: "profile entry name must be 1-64 characters using letters, numbers, dot, underscore, or hyphen" });
			continue;
		}
		if (matches.length > 1) {
			invalidNames.add(name);
			diagnostics.push({ path: directory, message: `duplicate profile '${name}' is defined as both a JSON file and a directory` });
			continue;
		}

		const candidate = matches[0]!;
		let parsed: ProfileDefinition;
		try {
			const stat = fs.statSync(candidate.configPath);
			if (!stat.isFile()) throw new Error(`${path.basename(candidate.configPath)} must be a regular file`);
			if (stat.size > MAX_PROFILE_BYTES) throw new Error(`profile exceeds ${MAX_PROFILE_BYTES} bytes`);
			parsed = parseProfile(JSON.parse(fs.readFileSync(candidate.configPath, "utf8")) as unknown, name);
		} catch (error) {
			invalidNames.add(name);
			diagnostics.push({ path: candidate.configPath, message: error instanceof Error ? error.message : String(error) });
			continue;
		}

		let systemPrompt: string | undefined;
		if (candidate.directoryPath) {
			try {
				systemPrompt = readSystemPrompt(candidate.directoryPath);
			} catch (error) {
				invalidNames.add(name);
				diagnostics.push({
					path: path.join(candidate.directoryPath, PROFILE_SYSTEM_PROMPT_FILE),
					message: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
		}
		profiles.set(parsed.name, {
			...parsed,
			...(systemPrompt !== undefined ? { systemPrompt } : {}),
			source,
			sourcePath: candidate.configPath,
		});
	}
	return { profiles, invalidNames };
}

export function globalProfilesDir(): string {
	return path.join(getAgentDir(), "facets", "profiles");
}

export function projectProfilesDir(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "facets", "profiles");
}

function ancestorDirectories(cwd: string): string[] {
	const directories: string[] = [];
	let current = path.resolve(cwd);
	while (true) {
		directories.push(current);
		const parent = path.dirname(current);
		if (parent === current) return directories;
		current = parent;
	}
}

export function loadProfiles(cwd: string, includeProject: boolean): ProfileCatalog {
	const diagnostics: ProfileDiagnostic[] = [];
	const global = loadDirectory(globalProfilesDir(), "global", diagnostics);
	const profiles = global.profiles;
	if (includeProject) {
		for (const directory of ancestorDirectories(cwd).reverse()) {
			const project = loadDirectory(projectProfilesDir(directory), "project", diagnostics);
			for (const name of project.invalidNames) profiles.delete(name);
			for (const [name, profile] of project.profiles) profiles.set(name, profile);
		}
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
			...ancestorDirectories(cwd).flatMap((directory) => [
				path.join(directory, CONFIG_DIR_NAME, "skills", expanded),
				path.join(directory, ".agents", "skills", expanded),
			]),
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
		resolvedSkills: (profile.skills ?? []).map((skill) => materializeProfileSkill(resolveSkill(skill, profile, cwd))),
		resolvedExtensions: [],
	};
}
