import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { applyProfileTools, ProfileToolPolicy } from "../src/profiles/tool-policy.js";

function policyFixture() {
	let handler: (event: ToolCallEvent) => unknown;
	const pi = { on: (event: string, callback: typeof handler) => {
		assert.equal(event, "tool_call");
		handler = callback;
	} } as unknown as ExtensionAPI;
	const policy = new ProfileToolPolicy(pi);
	const call = (toolName: string, parentToolCallId?: string) => handler({
		type: "tool_call", toolName, toolCallId: "call-1", input: {}, parentToolCallId,
	} as ToolCallEvent);
	return { policy, call };
}

test("leaves tools unrestricted when no profile is selected", () => {
	const { policy, call } = policyFixture();
	assert.equal(call("write"), undefined);
	policy.allow("reviewer", ["read"]);
	policy.clear();
	assert.equal(call("write", "codemode-1"), undefined);
});

test("enforces the same allowlist for direct, nested, and dynamically registered tools", () => {
	const { policy, call } = policyFixture();
	const tools = ["read", "talk"];
	policy.allow("reviewer", tools);
	tools.push("write");
	for (const parent of [undefined, "codemode-1", "codemode-1/1"]) {
		assert.equal(call("read", parent), undefined);
		assert.equal(call("talk", parent), undefined);
		assert.deepEqual(call("write", parent), { block: true, reason: "Tool 'write' is not allowed by Facets profile 'reviewer'." });
		assert.deepEqual(call("new_deferred_tool", parent), { block: true, reason: "Tool 'new_deferred_tool' is not allowed by Facets profile 'reviewer'." });
	}
});

test("fails closed during initialization and after a profile error", () => {
	const { policy, call } = policyFixture();
	policy.denyAll("Profile failed");
	assert.deepEqual(call("read"), { block: true, reason: "Profile failed" });
	policy.allow("reviewer", ["read"]);
	assert.equal(call("read"), undefined);
	policy.denyAll("Profile failed again");
	assert.deepEqual(call("read", "nested"), { block: true, reason: "Profile failed again" });
});

test("checks both registration and effective activation before accepting profile tools", () => {
	let selected: string[] = [];
	const pi = {
		getAllTools: () => [{ name: "read" }, { name: "hidden", exposure: "hidden" }],
		setActiveTools: (tools: string[]) => { selected = tools; },
		getActiveTools: () => selected,
	} as unknown as ExtensionAPI;
	assert.throws(() => applyProfileTools(pi, "reviewer", ["missing"]), /unavailable tools: missing/);
	assert.throws(() => applyProfileTools(pi, "reviewer", ["hidden"]), /unavailable tools: hidden/);
	applyProfileTools(pi, "reviewer", ["read"]);
	assert.deepEqual(selected, ["read"]);
	pi.getActiveTools = () => [];
	assert.throws(() => applyProfileTools(pi, "reviewer", ["read"]), /could not activate tools: read/);
});
