import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerParentTools } from "../src/tools/parent.js";

interface CapturedTool {
	name: string;
	renderCall?: (args: unknown, theme: unknown, context: { expanded: boolean; state?: Record<string, unknown> }) => { render(width: number): string[] };
	renderResult?: (result: unknown, options: { isPartial: boolean }, theme: unknown, context?: { isError: boolean }) => { render(width: number): string[] };
}

test("renders configured tools and skills under a subagent launch", () => {
	const tools: CapturedTool[] = [];
	const pi = { registerTool: (tool: CapturedTool) => tools.push(tool) } as unknown as ExtensionAPI;
	registerParentTools(pi, { runs: new Map() } as never);
	assert.deepEqual(tools.map((tool) => tool.name), ["create_child", "talk", "close_child", "list_child"]);
	const delegate = tools.find((tool) => tool.name === "create_child");
	assert.ok(delegate?.renderCall);
	assert.ok(delegate.renderResult);
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const call = delegate.renderCall({ title: "Research topic", profile: "research" }, theme, { expanded: false })
		.render(240).join("\n");
	assert.match(call, /^delegate · Research topic/);
	const component = delegate.renderResult({
		details: {
			title: "Research topic",
			profile: "research",
			adapter: "herdr",
			sessionPersistence: "persistent",
			tools: ["web_search", "fetch_content"],
			skills: ["source-review"],
		},
	}, { isPartial: false }, theme);
	const rendered = component.render(240).join("\n");
	assert.match(rendered, /Research topic · research · persistent · herdr/);
	assert.match(rendered, /tools\s+web_search · fetch_content/);
	assert.match(rendered, /skills\s+source-review/);
	assert.doesNotMatch(rendered, /talk/);
});

test("renders talk message content", () => {
	const tools: CapturedTool[] = [];
	const pi = { registerTool: (tool: CapturedTool) => tools.push(tool) } as unknown as ExtensionAPI;
	const runs = new Map([["c3b22f28-abcd", { runId: "c3b22f28-abcd", title: "Review MR" }]]);
	registerParentTools(pi, { runs, titleFor: () => "Review MR" } as never);
	const talk = tools.find((tool) => tool.name === "talk");
	assert.ok(talk?.renderCall);
	assert.ok(talk.renderResult);
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const message = Array.from({ length: 12 }, (_, index) => `审查结论 ${index + 1}`).join("\n");
	const args = { runId: "c3b22f28-abcd", message };
	const call = talk.renderCall(args, theme, { expanded: false }).render(120).map((line) => line.trimEnd()).join("\n");
	assert.match(call, /^› message send · Review MR\n\n审查结论 1/);
	assert.match(call, /审查结论 3/);
	assert.doesNotMatch(call, /审查结论 4/);
	assert.match(call, /\.\.\. \(9 more lines, 12 total, ctrl\+o to expand\)/);
	const expanded = talk.renderCall(args, theme, { expanded: true }).render(120).map((line) => line.trimEnd()).join("\n");
	assert.match(expanded, /审查结论 11\n审查结论 12/);
	const result = talk.renderResult({ details: {} }, { isPartial: false }, theme, { isError: false })
		.render(120).join("\n");
	assert.equal(result.trim(), "");
	const close = tools.find((tool) => tool.name === "close_child");
	assert.ok(close?.renderCall);
	const closeCall = close.renderCall({ runId: "c3b22f28" }, theme, { expanded: false, state: {} })
		.render(120).join("\n").trimEnd();
	assert.equal(closeCall, "close · Review MR");
});

test("renders open Child sessions as compact cards with readable durations", () => {
	const tools: CapturedTool[] = [];
	const pi = { registerTool: (tool: CapturedTool) => tools.push(tool) } as unknown as ExtensionAPI;
	registerParentTools(pi, { runs: new Map() } as never);
	const list = tools.find((tool) => tool.name === "list_child");
	assert.ok(list?.renderCall);
	assert.ok(list.renderResult);
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	assert.equal(list.renderCall({}, theme, { expanded: false }).render(120).join("\n").trimEnd(), "children");
	const rendered = list.renderResult({
		details: {
			runs: [{
				runId: "c3b22f28-abcd",
				title: "发布舆情 web 与 job",
				profile: "misc",
				sessionPersistence: "ephemeral",
				adapter: "herdr",
				elapsedSeconds: 2788,
			}],
		},
	}, { isPartial: false }, theme).render(120).join("\n");
	assert.match(rendered, /• 发布舆情 web 与 job/);
	assert.match(rendered, /c3b22f28 · misc · ephemeral · herdr · 46m/);
	assert.doesNotMatch(rendered, /\[failed\]|<misc>|2788s/);
});
