import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	globalParentContextPath,
	loadParentContext,
	projectParentContextPath,
} from "../src/parent-context.js";

let root: string;
let cwd: string;
let previousAgentDir: string | undefined;

function write(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-parent-context-"));
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

test("loads global and trusted ancestor PARENT.md files from broadest to nearest", () => {
	const project = path.join(root, "project");
	const workspace = path.join(project, "workspace");
	write(globalParentContextPath(), "global parent rule\n");
	write(projectParentContextPath(project), "project parent rule\n");
	write(projectParentContextPath(workspace), "workspace parent rule\n");

	const loaded = loadParentContext(cwd, true);
	assert.deepEqual(loaded.paths, [
		globalParentContextPath(),
		projectParentContextPath(project),
		projectParentContextPath(workspace),
	]);
	assert.equal(loaded.diagnostics.length, 0);
	assert.ok(loaded.content.indexOf("global parent rule") < loaded.content.indexOf("project parent rule"));
	assert.ok(loaded.content.indexOf("project parent rule") < loaded.content.indexOf("workspace parent rule"));
});

test("does not load project PARENT.md files when project resources are untrusted", () => {
	write(globalParentContextPath(), "global parent rule\n");
	write(projectParentContextPath(path.join(root, "project")), "project parent rule\n");

	const loaded = loadParentContext(cwd, false);
	assert.deepEqual(loaded.paths, [globalParentContextPath()]);
	assert.match(loaded.content, /global parent rule/);
	assert.doesNotMatch(loaded.content, /project parent rule/);
});
