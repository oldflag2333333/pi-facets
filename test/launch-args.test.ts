import assert from "node:assert/strict";
import { test } from "node:test";
import { subCapabilityArgs } from "../src/profiles/launch-args.js";
import type { ResolvedProfile } from "../src/profiles/types.js";

const profile: ResolvedProfile = {
	version: 1,
	name: "reviewer",
	source: "global",
	sourcePath: "/tmp/reviewer.json",
	model: "provider/model/name",
	thinkingLevel: "provider-level",
	tools: ["read", "talk"],
	skills: ["review"],
	resolvedSkills: ["/tmp/review/SKILL.md"],
	resolvedExtensions: ["/tmp/web-extension.ts"],
};

test("builds one Sub capability argument set from the resolved profile", () => {
	assert.deepEqual(subCapabilityArgs(profile, "/tmp/facets.ts"), [
		"-e", "/tmp/web-extension.ts",
		"--tools", "read,talk",
		"--model", "provider/model/name",
		"--thinking", "provider-level",
		"--no-skills",
		"--skill", "/tmp/review/SKILL.md",
	]);
});
