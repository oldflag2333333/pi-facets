import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerParentTools } from "../src/tools/parent.js";

interface CapturedTool {
	name: string;
	renderResult?: (result: unknown, options: { isPartial: boolean }, theme: unknown) => { render(width: number): string[] };
}

test("renders configured tools and skills under a subagent launch", () => {
	const tools: CapturedTool[] = [];
	const pi = { registerTool: (tool: CapturedTool) => tools.push(tool) } as unknown as ExtensionAPI;
	registerParentTools(pi, { runs: new Map() } as never);
	const delegate = tools.find((tool) => tool.name === "delegate_pi");
	assert.ok(delegate?.renderResult);
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const component = delegate.renderResult({
		details: {
			title: "Research topic",
			profile: "research",
			state: "running",
			adapter: "herdr",
			tools: ["web_search", "fetch_content"],
			skills: ["source-review"],
		},
	}, { isPartial: false }, theme);
	const rendered = component.render(240).join("\n");
	assert.match(rendered, /Research topic · research · running · herdr/);
	assert.match(rendered, /tools\s+web_search · fetch_content/);
	assert.match(rendered, /skills\s+source-review/);
	assert.doesNotMatch(rendered, /ask_parent|return_to_parent/);
});
