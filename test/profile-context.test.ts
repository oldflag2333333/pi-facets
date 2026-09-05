import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProfilesContext } from "../src/profiles/context.js";
import type { LoadedProfile, ProfileCatalog } from "../src/profiles/types.js";

function profile(name: string, source: "global" | "project", description?: string): LoadedProfile {
	return {
		version: 1,
		name,
		source,
		sourcePath: `/tmp/${name}.json`,
		tools: ["read"],
		...(description ? { description } : {}),
	};
}

test("builds a concise startup context with the effective profiles", () => {
	const catalog: ProfileCatalog = {
		profiles: new Map([
			["research", profile("research", "global", "Research the web")],
			["reviewer", profile("reviewer", "project", "Review this project")],
		]),
		diagnostics: [],
	};
	const context = buildProfilesContext(catalog);
	assert.match(context, /Available Facets delegation profiles/);
	assert.match(context, /research \[global\]: Research the web/);
	assert.match(context, /reviewer \[project\]: Review this project/);
	assert.match(context, /delegate_pi\.profile/);
	assert.doesNotMatch(context, /ask_parent|return_to_parent|tools:/);
});

test("tells the parent not to delegate when no valid profile exists", () => {
	const context = buildProfilesContext({ profiles: new Map(), diagnostics: [] });
	assert.match(context, /No valid profiles are configured/);
});
