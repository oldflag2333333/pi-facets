import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildChildSystemPrompt,
	buildStartupSystemPrompt,
	CHILD_PROTOCOL,
} from "../src/profiles/system-prompt.js";
import type { ResolvedProfile } from "../src/profiles/types.js";

function profile(overrides: Partial<ResolvedProfile> = {}): ResolvedProfile {
	return {
		version: 1,
		name: "reviewer",
		tools: ["read"],
		instructions: "Follow the profile instructions.",
		source: "global",
		sourcePath: "/tmp/reviewer/config.json",
		resolvedSkills: [],
		resolvedExtensions: [],
		...overrides,
	};
}

test("uses handwritten SYSTEM.md verbatim before the mandatory Child protocol", () => {
	const result = buildChildSystemPrompt("Pi generated prompt", profile({
		systemPrompt: "Handwritten system prompt.\n",
	}));
	assert.equal(result, `Handwritten system prompt.\n\n${CHILD_PROTOCOL}`);
	assert.doesNotMatch(result, /Pi generated prompt|Follow the profile instructions/);
});

test("keeps the existing Child prompt composition without SYSTEM.md", () => {
	const result = buildChildSystemPrompt("Pi generated prompt", profile());
	assert.equal(
		result,
		`Pi generated prompt\n\n${CHILD_PROTOCOL}\n\n## Facets profile: reviewer\nFollow the profile instructions.`,
	);
});

test("uses handwritten SYSTEM.md as the complete direct-startup prompt", () => {
	const result = buildStartupSystemPrompt(
		"Pi generated prompt",
		profile({ systemPrompt: "Handwritten system prompt." }),
		"Available Facets profiles",
	);
	assert.equal(result, "Handwritten system prompt.");
});

test("keeps the existing direct-startup composition without SYSTEM.md", () => {
	const result = buildStartupSystemPrompt("Pi generated prompt", profile(), "Available Facets profiles");
	assert.equal(
		result,
		"Pi generated prompt\n\nAvailable Facets profiles\n\n## Active Facets profile: reviewer\nFollow the profile instructions.",
	);
});
