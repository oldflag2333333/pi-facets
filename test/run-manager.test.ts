import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChannel, listTalkToChild, readManifest } from "../src/channel.js";
import { ParentRunManager } from "../src/run-manager.js";
import type { RunSnapshot } from "../src/types.js";

let root: string;
let previousRuntimeDir: string | undefined;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-manager-"));
	previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = root;
});

afterEach(() => {
	if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
	fs.rmSync(root, { recursive: true, force: true });
});

function openRun(manager: ParentRunManager): RunSnapshot {
	const profile = {
		version: 1 as const,
		name: "reviewer",
		tools: ["read"],
		sessionPersistence: "persistent" as const,
		source: "global" as const,
		sourcePath: "/tmp/reviewer.json",
		resolvedSkills: [],
		resolvedExtensions: [],
	};
	const channel = createChannel({
		runId: "open-run",
		parentSessionId: "parent-session",
		title: "Review MR",
		task: "Review it.",
		cwd: "/tmp/project",
		profile,
	});
	const run: RunSnapshot = {
		version: 1,
		runId: channel.runId,
		parentSessionId: channel.parentSessionId,
		title: channel.title,
		cwd: channel.cwd,
		profileName: profile.name,
		sessionPersistence: "persistent",
		channelDir: channel.channelDir,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		surface: { adapter: "herdr", tabId: "w1:t2", paneId: "w1:p2" },
	};
	manager.runs.set(run.runId, run);
	return run;
}

test("talks to and explicitly closes an open Child", async () => {
	const calls: string[][] = [];
	const pi = {
		appendEntry: () => {},
		sendMessage: () => {},
		exec: async (_command: string, args: string[]) => {
			calls.push(args);
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		},
	} as unknown as ExtensionAPI;
	const manager = new ParentRunManager(pi);
	const run = openRun(manager);

	const sent = manager.talk(run.runId, "Please inspect the latest commit.");
	assert.equal(sent.run, run);
	assert.equal(listTalkToChild(run.channelDir, readManifest(run.channelDir))[0]?.message, "Please inspect the latest commit.");

	await manager.close(run.runId, "Accepted");
	assert.equal(manager.runs.has(run.runId), false);
	assert.equal(fs.existsSync(run.channelDir), false);
	assert.deepEqual(calls.at(-1), ["tab", "close", "w1:t2"]);
});
