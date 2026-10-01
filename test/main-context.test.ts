import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	globalMainContextPath,
	loadMainContext,
	projectMainContextPath,
} from "../src/main-context.js";

let root: string;
let cwd: string;
let previousAgentDir: string | undefined;

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-main-context-"));
	cwd = path.join(root, "project", "workspace", "requirement");
	fs.mkdirSync(cwd, { recursive: true });
	previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
});

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	fs.rmSync(root, { recursive: true, force: true });
});

test("loads global and trusted ancestor MAIN.md files from broadest to nearest", () => {
	const project = path.join(root, "project");
	const workspace = path.join(project, "workspace");
	write(globalMainContextPath(), "global main rule\n");
	write(projectMainContextPath(project), "project main rule\n");
	write(projectMainContextPath(workspace), "workspace main rule\n");

	const loaded = loadMainContext(cwd, true);
	assert.deepEqual(loaded.paths, [
		globalMainContextPath(),
		projectMainContextPath(project),
		projectMainContextPath(workspace),
	]);
	assert.equal(loaded.diagnostics.length, 0);
	assert.ok(loaded.content.indexOf("global main rule") < loaded.content.indexOf("project main rule"));
	assert.ok(loaded.content.indexOf("project main rule") < loaded.content.indexOf("workspace main rule"));
});

test("does not load project MAIN.md files when project resources are untrusted", () => {
	write(globalMainContextPath(), "global main rule\n");
	write(projectMainContextPath(path.join(root, "project")), "project main rule\n");

	const loaded = loadMainContext(cwd, false);
	assert.deepEqual(loaded.paths, [globalMainContextPath()]);
	assert.match(loaded.content, /global main rule/);
	assert.doesNotMatch(loaded.content, /project main rule/);
});
