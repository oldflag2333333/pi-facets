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

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-profiles-"));
	cwd = path.join(root, "project");
	fs.mkdirSync(cwd);
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
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
