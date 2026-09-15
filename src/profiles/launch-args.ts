import type { ResolvedProfile } from "./types.js";

export const SUB_CONTROL_TOOLS = ["talk"] as const;

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

export function subCapabilityArgs(profile: ResolvedProfile, facetsEntryPath: string): string[] {
	const args: string[] = [];
	for (const extension of unique(profile.resolvedExtensions).filter((entry) => entry !== facetsEntryPath)) {
		args.push("-e", extension);
	}
	args.push("--tools", unique([...profile.tools, ...SUB_CONTROL_TOOLS]).join(","));
	if (profile.model) args.push("--model", profile.model);
	if (profile.thinkingLevel) args.push("--thinking", profile.thinkingLevel);
	args.push("--no-skills");
	for (const skill of profile.resolvedSkills) args.push("--skill", skill);
	return args;
}
