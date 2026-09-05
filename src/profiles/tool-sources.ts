import * as fs from "node:fs";
import * as path from "node:path";
import type { ResolvedProfile } from "./types.js";

interface ToolSource {
	name: string;
	sourceInfo: {
		path: string;
		source: string;
	};
}

export function resolveToolExtensions(profile: ResolvedProfile, tools: ToolSource[]): ResolvedProfile {
	const available = new Map(tools.map((tool) => [tool.name, tool]));
	const extensionPaths = new Set<string>();
	for (const name of profile.tools) {
		const tool = available.get(name);
		if (!tool) throw new Error(`Profile '${profile.name}' references unavailable tool '${name}'.`);
		if (tool.sourceInfo.source === "builtin") continue;
		const sourcePath = tool.sourceInfo.path;
		if (tool.sourceInfo.source === "sdk" || !sourcePath || sourcePath.startsWith("<")) {
			throw new Error(`Profile '${profile.name}' tool '${name}' cannot be loaded in an isolated child process.`);
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(sourcePath);
		} catch {
			throw new Error(`Profile '${profile.name}' tool '${name}' extension is missing: ${sourcePath}.`);
		}
		if (!stat.isFile() && !stat.isDirectory()) {
			throw new Error(`Profile '${profile.name}' tool '${name}' has an unsupported extension path: ${sourcePath}.`);
		}
		extensionPaths.add(path.resolve(sourcePath));
	}
	return { ...profile, resolvedExtensions: [...extensionPaths] };
}
