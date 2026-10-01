import type { ResolvedProfile } from "./types.js";

export const SUB_PROTOCOL = `## Facets Sub protocol
You are an isolated Sub Pi working with a Main Pi. You have not received the Main's conversation and must not read Pi session files. Use talk whenever you need information from the Main or need to deliver work. Each talk sends one message to the Main and ends the current turn. Remain available after delivery. The Main alone decides whether to respond, request more work, or close this Sub session. Never close the session yourself.`;

export function buildSubSystemPrompt(baseSystemPrompt: string, profile: ResolvedProfile): string {
	const base = profile.systemPrompt === undefined ? baseSystemPrompt : profile.systemPrompt.trimEnd();
	const profileInstructions = profile.systemPrompt === undefined && profile.instructions
		? `\n\n## Facets profile: ${profile.name}\n${profile.instructions}`
		: "";
	return `${base}\n\n${SUB_PROTOCOL}${profileInstructions}`;
}

export function buildStartupSystemPrompt(
	baseSystemPrompt: string,
	profile: ResolvedProfile | undefined,
	profilesContext: string,
): string | undefined {
	if (profile?.systemPrompt !== undefined) return profile.systemPrompt;
	const activeInstructions = profile?.instructions
		? `## Active Facets profile: ${profile.name}\n${profile.instructions}`
		: "";
	const additions = [profilesContext, activeInstructions].filter(Boolean).join("\n\n");
	return additions ? `${baseSystemPrompt}\n\n${additions}` : undefined;
}
