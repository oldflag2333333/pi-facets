import type { ResolvedProfile } from "./types.js";

export const CHILD_CONTROL_TOOLS = ["ask_parent", "return_to_parent"] as const;

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

export function childCapabilityArgs(profile: ResolvedProfile, facetsEntryPath: string): string[] {
	const args: string[] = [];
	for (const extension of unique(profile.resolvedExtensions).filter((entry) => entry !== facetsEntryPath)) {
		args.push("-e", extension);
	}
	args.push("--tools", unique([...profile.tools, ...CHILD_CONTROL_TOOLS]).join(","));
	if (profile.model) args.push("--model", profile.model);
	if (profile.thinkingLevel) args.push("--thinking", profile.thinkingLevel);
	args.push("--no-skills");
	for (const skill of profile.resolvedSkills) args.push("--skill", skill);
	return args;
}
