import type { ResolvedProfile } from "./types.js";

export const CHILD_PROTOCOL = `## Facets child protocol
You are an isolated child Pi working with a Parent Pi. You have not received the Parent's conversation and must not read Pi session files. Use talk whenever you need information from the Parent or need to deliver work. Each talk sends one message to the Parent and ends the current turn. Remain available after delivery. The Parent alone decides whether to respond, request more work, or close this child session. Never close the session yourself.`;

export function buildChildSystemPrompt(baseSystemPrompt: string, profile: ResolvedProfile): string {
	const base = profile.systemPrompt === undefined ? baseSystemPrompt : profile.systemPrompt.trimEnd();
	const profileInstructions = profile.systemPrompt === undefined && profile.instructions
		? `\n\n## Facets profile: ${profile.name}\n${profile.instructions}`
		: "";
	return `${base}\n\n${CHILD_PROTOCOL}${profileInstructions}`;
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
