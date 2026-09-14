import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChannel, listTalkToChild, listTalkToParent, readManifest, talkToParent } from "../src/channel.js";
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

test("talks to and explicitly closes an open Child without triggering a Parent turn", async () => {
	const calls: string[][] = [];
	const entries: Array<{ type: string; data: unknown }> = [];
	const messages: unknown[] = [];
	const pi = {
		appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
		sendMessage: (message: unknown) => messages.push(message),
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
	assert.deepEqual(messages, []);
	assert.deepEqual(entries, [{ type: "facets-notice", data: "Child closed: Review MR" }]);
});

test("waits for an idle Parent and triggers exactly one turn for a Child message", async () => {
	const messages: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		appendEntry: () => {},
		sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
	} as unknown as ExtensionAPI;
	const manager = new ParentRunManager(pi);
	const run = openRun(manager);
	talkToParent(run.channelDir, readManifest(run.channelDir), "Review complete.");

	let idle = false;
	const ctx = {
		isIdle: () => idle,
		sessionManager: { getEntries: () => [] },
	} as unknown as ExtensionContext;
	manager.start(ctx);
	assert.equal(messages.length, 0);

	idle = true;
	await new Promise((resolve) => setTimeout(resolve, 500));
	manager.shutdown();

	assert.equal(messages.length, 1);
	const notification = messages[0];
	assert.ok(notification);
	assert.deepEqual(notification.options, { deliverAs: "followUp", triggerTurn: true });
	const delivered = notification.message as { content?: string; details?: { title?: string; message?: string } };
	assert.match(String(delivered.content), /Review complete\./);
	assert.deepEqual(delivered.details, { title: "Review MR", message: "Review complete." });
	assert.deepEqual(listTalkToParent(run.channelDir, readManifest(run.channelDir)), []);
});
