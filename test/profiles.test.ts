import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	globalProfilesDir,
	loadProfiles,
	projectProfilesDir,
	resolveProfile,
} from "../src/profiles/loader.js";

let root: string;
let cwd: string;
let previousAgentDir: string | undefined;
let previousRuntimeDir: string | undefined;

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-profiles-"));
	cwd = path.join(root, "project");
	fs.mkdirSync(cwd);
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
	process.env.XDG_RUNTIME_DIR = path.join(root, "runtime");
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
	fs.rmSync(root, { recursive: true, force: true });
});

test("loads global profiles without applying an internal thinking-level enum", () => {
	writeJson(path.join(globalProfilesDir(), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read", "grep"],
		thinkingLevel: "provider-defined-level",
	});
	const catalog = loadProfiles(cwd, false);
	assert.equal(catalog.diagnostics.length, 0);
	assert.equal(catalog.profiles.get("reviewer")?.source, "global");
	assert.equal(catalog.profiles.get("reviewer")?.thinkingLevel, "provider-defined-level");
});

test("loads persistent session configuration and rejects unknown values", () => {
	writeJson(path.join(globalProfilesDir(), "persistent.json"), {
		version: 1,
		name: "persistent",
		tools: ["read"],
		sessionPersistence: "persistent",
	});
	writeJson(path.join(globalProfilesDir(), "invalid.json"), {
		version: 1,
		name: "invalid",
		tools: ["read"],
		sessionPersistence: "forever",
	});
	const catalog = loadProfiles(cwd, false);
	assert.equal(catalog.profiles.get("persistent")?.sessionPersistence, "persistent");
	assert.equal(catalog.profiles.has("invalid"), false);
	assert.match(catalog.diagnostics[0]?.message ?? "", /sessionPersistence/);
});

test("trusted project profiles override same-named global profiles", () => {
	writeJson(path.join(globalProfilesDir(), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
	});
	writeJson(path.join(projectProfilesDir(cwd), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read", "grep"],
	});
	assert.deepEqual(loadProfiles(cwd, false).profiles.get("reviewer")?.tools, ["read"]);
	const trusted = loadProfiles(cwd, true).profiles.get("reviewer");
	assert.equal(trusted?.source, "project");
	assert.deepEqual(trusted?.tools, ["read", "grep"]);
});

test("loads ancestor profiles and lets the nearest directory override them", () => {
	const nestedCwd = path.join(cwd, "workspace", "requirement");
	fs.mkdirSync(nestedCwd, { recursive: true });
	writeJson(path.join(projectProfilesDir(cwd), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
	});
	writeJson(path.join(projectProfilesDir(path.join(cwd, "workspace")), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read", "grep"],
	});

	const profile = loadProfiles(nestedCwd, true).profiles.get("reviewer");
	assert.equal(profile?.sourcePath, path.join(projectProfilesDir(path.join(cwd, "workspace")), "reviewer.json"));
	assert.deepEqual(profile?.tools, ["read", "grep"]);
});

test("resolves configured skill names to concrete SKILL.md paths", () => {
	const skill = path.join(process.env.PI_CODING_AGENT_DIR!, "skills", "code-review", "SKILL.md");
	fs.mkdirSync(path.dirname(skill), { recursive: true });
	fs.writeFileSync(skill, "---\nname: code-review\ndescription: Review code\n---\n");
	writeJson(path.join(globalProfilesDir(), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
		skills: ["code-review"],
	});
	assert.deepEqual(resolveProfile("reviewer", cwd, false).resolvedSkills, [skill]);
});

test("makes profile-selected manual skills model-visible without modifying their source", () => {
	const skillDir = path.join(process.env.PI_CODING_AGENT_DIR!, "skills", "manual-review");
	const skill = path.join(skillDir, "SKILL.md");
	const source = "---\nname: manual-review\ndescription: Review manually\ndisable-model-invocation: true\n---\n\nRead [guide](guide.md).\n";
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(skill, source);
	fs.writeFileSync(path.join(skillDir, "guide.md"), "review guide\n");
	writeJson(path.join(globalProfilesDir(), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
		skills: ["manual-review"],
	});

	const [resolved] = resolveProfile("reviewer", cwd, false).resolvedSkills;
	assert.ok(resolved);
	assert.notEqual(resolved, skill);
	assert.match(fs.readFileSync(resolved, "utf8"), /disable-model-invocation: false/);
	assert.equal(fs.readFileSync(skill, "utf8"), source);
	assert.equal(fs.readFileSync(path.join(path.dirname(resolved), "guide.md"), "utf8"), "review guide\n");
});

test("resolves skill names from ancestor project directories", () => {
	const nestedCwd = path.join(cwd, "workspace", "requirement");
	fs.mkdirSync(nestedCwd, { recursive: true });
	const skill = path.join(cwd, ".agents", "skills", "project-review", "SKILL.md");
	fs.mkdirSync(path.dirname(skill), { recursive: true });
	fs.writeFileSync(skill, "---\nname: project-review\ndescription: Review this project\n---\n");
	writeJson(path.join(projectProfilesDir(cwd), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
		skills: ["project-review"],
	});

	assert.deepEqual(resolveProfile("reviewer", nestedCwd, true).resolvedSkills, [skill]);
});

test("reports invalid profiles and does not load them", () => {
	writeJson(path.join(globalProfilesDir(), "wrong-name.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
	});
	const catalog = loadProfiles(cwd, false);
	assert.equal(catalog.profiles.size, 0);
	assert.match(catalog.diagnostics[0]?.message ?? "", /must match filename/);
});

test("an invalid project override does not silently fall back to a global profile", () => {
	writeJson(path.join(globalProfilesDir(), "reviewer.json"), {
		version: 1,
		name: "reviewer",
		tools: ["read"],
	});
	writeJson(path.join(projectProfilesDir(cwd), "reviewer.json"), {
		version: 1,
		name: "wrong-name",
		tools: ["read", "bash"],
	});
	const catalog = loadProfiles(cwd, true);
	assert.equal(catalog.profiles.has("reviewer"), false);
	assert.throws(() => resolveProfile("reviewer", cwd, true), /Invalid profiles/);
});
