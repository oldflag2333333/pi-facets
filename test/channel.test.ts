import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	createChannel,
	listTalkToChild,
	listTalkToParent,
	readChildClosed,
	readClose,
	readManifest,
	removeChannel,
	removeTalk,
	talkToChild,
	talkToParent,
	writeChildClosed,
	writeClose,
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

function channel() {
	return createChannel({
		runId: "run-1",
		parentSessionId: "session-1",
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

	const parentMessage = talkToParent(created.channelDir, manifest, "Delivery from Child");
	const childMessage = talkToChild(created.channelDir, manifest, "Feedback from Parent");
	assert.deepEqual(listTalkToParent(created.channelDir, manifest), [parentMessage]);
	assert.deepEqual(listTalkToChild(created.channelDir, manifest), [childMessage]);

	removeTalk(created.channelDir, "to-parent", parentMessage.id);
	removeTalk(created.channelDir, "to-child", childMessage.id);
	assert.deepEqual(listTalkToParent(created.channelDir, manifest), []);
	assert.deepEqual(listTalkToChild(created.channelDir, manifest), []);
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
	fs.writeFileSync(path.join(created.channelDir, "to-parent", "forged.json"), JSON.stringify(forged));
	assert.deepEqual(listTalkToParent(created.channelDir, manifest), []);
});

test("round-trips Parent close and manual Child closure", () => {
	const created = channel();
	const manifest = readManifest(created.channelDir);
	writeClose(created.channelDir, manifest, "Accepted");
	assert.equal(readClose(created.channelDir, manifest)?.reason, "Accepted");
	writeChildClosed(created.channelDir, manifest, "Closed manually");
	assert.equal(readChildClosed(created.channelDir, manifest)?.reason, "Closed manually");
});
