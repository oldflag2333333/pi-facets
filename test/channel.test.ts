import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	createChannel,
	clearActiveTurn,
	clearInterrupt,
	listTalkToSub,
	listTalkToMain,
	readSubClosed,
	readSubSessionInfo,
	readClose,
	readManifest,
	readActiveTurn,
	readInterrupt,
	removeChannel,
	removeTalk,
	talkToSub,
	talkToMain,
	writeSubClosed,
	writeSubSessionInfo,
	writeClose,
	writeActiveTurn,
	writeInterrupt,
} from "../src/channel.js";

const profile = {
	version: 1 as const,
	name: "reviewer",
	description: "Review only",
	tools: ["read", "grep"],
	thinkingLevel: "high",
	systemPrompt: "Handwritten system prompt.",
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

function channel() {
	return createChannel({
		runId: "run-1",
		mainSessionId: "session-1",
		title: "Review auth",
		task: "Review the auth flow.",
		cwd: "/tmp/project",
		profile,
	});
}

test("creates an isolated manifest and round-trips talk in both directions", () => {
	const created = channel();
	const manifest = readManifest(created.channelDir);
	assert.equal(manifest.runId, "run-1");
	assert.equal(manifest.token.length, 64);
	assert.equal(manifest.profile.systemPrompt, "Handwritten system prompt.");

	const mainMessage = talkToMain(created.channelDir, manifest, "Delivery from Sub");
	const subMessage = talkToSub(created.channelDir, manifest, "Feedback from Main");
	assert.deepEqual(listTalkToMain(created.channelDir, manifest), [mainMessage]);
	assert.deepEqual(listTalkToSub(created.channelDir, manifest), [subMessage]);

	removeTalk(created.channelDir, "to-main", mainMessage.id);
	removeTalk(created.channelDir, "to-sub", subMessage.id);
	assert.deepEqual(listTalkToMain(created.channelDir, manifest), []);
	assert.deepEqual(listTalkToSub(created.channelDir, manifest), []);
	removeChannel(created.channelDir);
});

test("rejects talk messages with a different capability token", () => {
	const created = channel();
	const manifest = readManifest(created.channelDir);
	const forged = {
		version: 1,
		id: "forged",
		runId: manifest.runId,
		token: "wrong",
		createdAt: Date.now(),
		message: "Leak context",
	};
	fs.writeFileSync(path.join(created.channelDir, "to-main", "forged.json"), JSON.stringify(forged));
	assert.deepEqual(listTalkToMain(created.channelDir, manifest), []);
});

test("round-trips persistent Sub session identity", () => {
	const created = channel();
	const manifest = readManifest(created.channelDir);
	const info = writeSubSessionInfo(created.channelDir, manifest, {
		sessionId: "sub-session-id",
		sessionFile: "/tmp/sub.jsonl",
	});
	assert.deepEqual(readSubSessionInfo(created.channelDir, manifest), info);
});

test("binds an interrupt to one authenticated active turn", () => {
	const created = channel();
	const manifest = readManifest(created.channelDir);
	const turn = writeActiveTurn(created.channelDir, manifest);
	assert.deepEqual(readActiveTurn(created.channelDir, manifest), turn);
	const request = writeInterrupt(created.channelDir, manifest, turn);
	assert.deepEqual(readInterrupt(created.channelDir, manifest), request);
	assert.equal(readInterrupt(created.channelDir, { ...manifest, token: "wrong" }), undefined);
	const nextTurn = writeActiveTurn(created.channelDir, manifest);
	clearActiveTurn(created.channelDir, turn);
	assert.deepEqual(readActiveTurn(created.channelDir, manifest), nextTurn);
	clearInterrupt(created.channelDir);
	assert.equal(readInterrupt(created.channelDir, manifest), undefined);
	clearActiveTurn(created.channelDir, nextTurn);
	assert.equal(readActiveTurn(created.channelDir, manifest), undefined);
});

test("round-trips Main close and manual Sub closure", () => {
	const created = channel();
	const manifest = readManifest(created.channelDir);
	writeClose(created.channelDir, manifest, "Accepted");
	assert.equal(readClose(created.channelDir, manifest)?.reason, "Accepted");
	writeSubClosed(created.channelDir, manifest, "Closed manually");
	assert.equal(readSubClosed(created.channelDir, manifest)?.reason, "Closed manually");
});
