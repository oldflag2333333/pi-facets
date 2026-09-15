import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createChannel, listTalkToSub, listTalkToMain, readManifest, talkToMain, writeSubSessionInfo } from "../src/channel.js";
import { MainRunManager } from "../src/run-manager.js";
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

function openRun(manager: MainRunManager): RunSnapshot {
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
		mainSessionId: "main-session",
		title: "Review MR",
		task: "Review it.",
		cwd: "/tmp/project",
		profile,
	});
	const run: RunSnapshot = {
		version: 1,
		runId: channel.runId,
		mainSessionId: channel.mainSessionId,
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

test("talks to and explicitly closes an open Sub without triggering a Main turn", async () => {
	const calls: string[][] = [];
	const messages: unknown[] = [];
	const pi = {
		appendEntry: () => {},
		sendMessage: (message: unknown) => messages.push(message),
		exec: async (_command: string, args: string[]) => {
			calls.push(args);
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		},
	} as unknown as ExtensionAPI;
	const manager = new MainRunManager(pi);
	const run = openRun(manager);

	const sent = manager.talk(run.runId, "Please inspect the latest commit.");
	assert.equal(sent.run, run);
	assert.equal(manager.titleFor(run.runId.slice(0, 4)), "Review MR");
	assert.equal(listTalkToSub(run.channelDir, readManifest(run.channelDir))[0]?.message, "Please inspect the latest commit.");

	await manager.close(run.runId, "Accepted");
	assert.equal(manager.runs.has(run.runId), false);
	assert.equal(manager.titleFor(run.runId), "Review MR");
	assert.equal(fs.existsSync(run.channelDir), false);
	assert.deepEqual(calls.at(-1), ["tab", "close", "w1:t2"]);
	assert.deepEqual(messages, []);
});

test("waits for an idle Main and triggers exactly one turn for a Sub message", async () => {
	const messages: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		appendEntry: () => {},
		sendMessage: (message: unknown, options: unknown) => messages.push({ message, options }),
	} as unknown as ExtensionAPI;
	const manager = new MainRunManager(pi);
	const run = openRun(manager);
	const manifest = readManifest(run.channelDir);
	writeSubSessionInfo(run.channelDir, manifest, { sessionId: "sub-session", sessionFile: "/tmp/sub.jsonl" });
	talkToMain(run.channelDir, manifest, "Review complete.");

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

	assert.equal(run.subSessionId, "sub-session");
	assert.equal(run.subSessionFile, "/tmp/sub.jsonl");
	assert.equal(messages.length, 1);
	const notification = messages[0];
	assert.ok(notification);
	assert.deepEqual(notification.options, { deliverAs: "followUp", triggerTurn: true });
	const delivered = notification.message as { content?: string; details?: { title?: string; message?: string } };
	assert.match(String(delivered.content), /Review complete\./);
	assert.deepEqual(delivered.details, { title: "Review MR", message: "Review complete." });
	assert.deepEqual(listTalkToMain(run.channelDir, readManifest(run.channelDir)), []);
});
