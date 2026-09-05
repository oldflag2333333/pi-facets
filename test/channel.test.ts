import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	createChannel,
	createQuestion,
	listQuestions,
	readCancel,
	readManifest,
	readReply,
	readResult,
	removeChannel,
	writeCancel,
	writeReply,
	writeResult,
} from "../src/channel.js";

const profile = {
	version: 1 as const,
	name: "reviewer",
	description: "Review only",
	tools: ["read", "grep"],
	thinkingLevel: "high",
	source: "global" as const,
	sourcePath: "/tmp/reviewer.json",
	resolvedSkills: [],
	resolvedExtensions: [],
};

let root: string;
let previousRuntimeDir: string | undefined;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-test-"));
	previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
	process.env.XDG_RUNTIME_DIR = root;
});

afterEach(() => {
	if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
	fs.rmSync(root, { recursive: true, force: true });
});

test("creates an isolated manifest and round-trips a question reply", () => {
	const channel = createChannel({
		runId: "run-1",
		parentSessionId: "session-1",
		title: "Review auth",
		task: "Review the auth flow.",
		cwd: "/tmp/project",
		profile,
	});
	const manifest = readManifest(channel.channelDir);
	assert.equal(manifest.runId, "run-1");
	assert.equal(manifest.token.length, 64);

	const question = createQuestion(channel.channelDir, manifest, {
		question: "Which behavior is intended?",
		choices: ["A", "B"],
		recommendation: "A",
	});
	assert.deepEqual(listQuestions(channel.channelDir, manifest), [question]);

	writeReply(channel.channelDir, manifest, question.requestId, "Choose B.");
	assert.equal(readReply(channel.channelDir, manifest, question.requestId)?.answer, "Choose B.");
	assert.deepEqual(listQuestions(channel.channelDir, manifest), []);
	removeChannel(channel.channelDir);
});

test("rejects cross-channel messages with a different capability token", () => {
	const channel = createChannel({
		runId: "run-2",
		parentSessionId: "session-2",
		title: "Task",
		task: "Do it.",
		cwd: "/tmp/project",
		profile,
	});
	const manifest = readManifest(channel.channelDir);
	const forged = {
		version: 1,
		type: "question",
		requestId: "forged",
		runId: manifest.runId,
		token: "wrong",
		createdAt: Date.now(),
		question: "Leak context",
	};
	fs.writeFileSync(path.join(channel.channelDir, "requests", "forged.json"), JSON.stringify(forged));
	assert.deepEqual(listQuestions(channel.channelDir, manifest), []);
});

test("round-trips final results and cancellation", () => {
	const channel = createChannel({
		runId: "run-3",
		parentSessionId: "session-3",
		title: "Implement",
		task: "Implement it.",
		cwd: "/tmp/project",
		profile,
	});
	const manifest = readManifest(channel.channelDir);
	writeResult(channel.channelDir, {
		version: 1,
		type: "result",
		runId: manifest.runId,
		token: manifest.token,
		createdAt: Date.now(),
		status: "completed",
		summary: "Done",
		changedFiles: ["src/a.ts"],
	});
	assert.equal(readResult(channel.channelDir, manifest)?.summary, "Done");

	writeCancel(channel.channelDir, manifest, "Stop now");
	assert.equal(readCancel(channel.channelDir, manifest)?.reason, "Stop now");
});
