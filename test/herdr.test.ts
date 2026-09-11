import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrTabAdapter } from "../src/adapters/herdr.js";
import type { ChildLaunchSpec } from "../src/types.js";

const spec: ChildLaunchSpec = {
	runId: "12345678-abcd-4000-8000-123456789abc",
	parentSessionId: "parent-session-1",
	title: "Research status",
	task: "Research this topic and summarize it.",
	cwd: "/tmp/project",
	channelDir: "/tmp/channel",
	token: "token",
	entryPath: "/tmp/facets.ts",
	profile: {
		version: 1,
		name: "research",
		sessionPersistence: "persistent",
		tools: ["web_search"],
		source: "global",
		sourcePath: "/tmp/research.json",
		resolvedSkills: [],
		resolvedExtensions: ["/tmp/web.ts"],
	},
};

test("starts an idle Pi before submitting work through herdr agent prompt", async () => {
	const previousEnvironment = process.env.HERDR_ENV;
	const previousWorkspace = process.env.HERDR_WORKSPACE_ID;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-herdr-"));
	const integration = path.join(agentDir, "extensions", "herdr-agent-state.ts");
	fs.mkdirSync(path.dirname(integration), { recursive: true });
	fs.writeFileSync(integration, "export default () => {}\n");
	process.env.HERDR_ENV = "1";
	process.env.HERDR_WORKSPACE_ID = "w1";
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const calls: Array<{ command: string; args: string[] }> = [];
	const fakePi = {
		exec: async (command: string, args: string[]) => {
			calls.push({ command, args });
			if (args[0] === "tab" && args[1] === "create") {
				return { code: 0, stdout: JSON.stringify({ result: { tab: { tab_id: "w1:t2" }, root_pane: { pane_id: "w1:p2" } } }), stderr: "", killed: false };
			}
			return { code: 0, stdout: "{}", stderr: "", killed: false };
		},
	} as unknown as ExtensionAPI;
	try {
		const handle = await new HerdrTabAdapter(fakePi).launch(spec);
		assert.deepEqual(handle, { adapter: "herdr", tabId: "w1:t2", paneId: "w1:p2" });
		const start = calls.find((call) => call.args[0] === "agent" && call.args[1] === "start");
		const prompt = calls.find((call) => call.args[0] === "agent" && call.args[1] === "prompt");
		assert.ok(start);
		assert.ok(prompt);
		const metadata = calls.find((call) => call.args[0] === "pane" && call.args[1] === "report-metadata");
		assert.equal(start.args.includes(spec.task), false);
		assert.equal(start.args.includes(integration), true);
		assert.equal(start.args.includes("--no-session"), false);
		assert.ok(metadata);
		assert.equal(metadata.args.includes("facets_role=subagent"), true);
		assert.equal(metadata.args.includes("facets_parent_session=parent-session-1"), true);
		assert.equal(prompt.args.includes(spec.task), true);
		assert.ok(calls.indexOf(start) < calls.indexOf(metadata));
		assert.ok(calls.indexOf(metadata) < calls.indexOf(prompt));
	} finally {
		if (previousEnvironment === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previousEnvironment;
		if (previousWorkspace === undefined) delete process.env.HERDR_WORKSPACE_ID;
		else process.env.HERDR_WORKSPACE_ID = previousWorkspace;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
