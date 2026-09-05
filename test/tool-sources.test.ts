import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { resolveToolExtensions } from "../src/profiles/tool-sources.js";
import type { ResolvedProfile } from "../src/profiles/types.js";

function profile(tools: string[]): ResolvedProfile {
	return {
		version: 1,
		name: "research",
		tools,
		source: "global",
		sourcePath: "/tmp/research.json",
		resolvedSkills: [],
		resolvedExtensions: [],
	};
}

test("derives and deduplicates extension entry paths from selected tool provenance", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-facets-tool-source-"));
	try {
		const extension = path.join(root, "web.ts");
		fs.writeFileSync(extension, "export default () => {}\n");
		const resolved = resolveToolExtensions(profile(["read", "web_search", "fetch_content"]), [
			{ name: "read", sourceInfo: { path: "<builtin:read>", source: "builtin" } },
			{ name: "web_search", sourceInfo: { path: extension, source: "npm:pi-web-access" } },
			{ name: "fetch_content", sourceInfo: { path: extension, source: "npm:pi-web-access" } },
		]);
		assert.deepEqual(resolved.resolvedExtensions, [extension]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("rejects tools whose implementation cannot be recreated in a child process", () => {
	assert.throws(
		() => resolveToolExtensions(profile(["sdk_tool"]), [
			{ name: "sdk_tool", sourceInfo: { path: "<sdk:sdk_tool>", source: "sdk" } },
		]),
		/cannot be loaded in an isolated child/,
	);
});
