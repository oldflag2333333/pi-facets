import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { ResolvedProfile } from "./types.js";

/** Custom-message runs do not pass through before_agent_start in Pi 1.0. */
export function bindPromptSections(pi: ExtensionAPI, keys: readonly string[], getSections: () => Record<string, string>): void {
	pi.on("before_agent_start", (event) => {
		const sections = getSections();
		for (const key of keys) {
			if (sections[key]) event.systemPromptOptions.sections[key] = sections[key]!;
			else delete event.systemPromptOptions.sections[key];
		}
	});
	pi.on("context_with_system", (event) => {
		const desired = getSections();
		const current = getCurrentSystemMessage(event.messages.filter((message) => message.role === "system"))?.sections ?? {};
		const patch: Record<string, string | null> = {};
		for (const key of keys) {
			const content = desired[key];
			const section = content ? `<${key}>\n${content}\n</${key}>` : undefined;
			if (section !== undefined && current[key] !== section) patch[key] = section;
			else if (section === undefined && current[key] != null) patch[key] = null;
		}
		if (Object.keys(patch).length === 0) return;
		// Supplement only missing/changed Facets sections, never replace the
		// leading prompt, native sections, tools, or conversation. Request-local
		// fallback preserves protocol/instructions for idle custom-message runs.
		return { messages: [...event.messages, { role: "system" as const, content: "", sections: patch, timestamp: Date.now() }] };
	});
}

export const SUB_PROTOCOL = `## Facets Sub protocol
You are an isolated Sub Pi working with a Main Pi. You have not received the Main's conversation and must not read Pi session files. Use talk whenever you need information from the Main or need to deliver work. Each talk sends one message to the Main and ends the current turn. Remain available after delivery. The Main alone decides whether to respond, request more work, or close this Sub session. Never close the session yourself.`;

export function applySubPromptSections(sections: Record<string, string>, profile: ResolvedProfile): void {
	sections.facets_sub_protocol = SUB_PROTOCOL;
	if (profile.instructions) sections.facets_profile = `## Facets profile: ${profile.name}\n${profile.instructions}`;
	else delete sections.facets_profile;
}

export function applyStartupPromptSections(
	sections: Record<string, string>,
	profile: ResolvedProfile | undefined,
	profilesContext: string,
): void {
	if (profilesContext) sections.facets_profiles = profilesContext;
	else delete sections.facets_profiles;
	if (profile?.instructions) sections.facets_profile = `## Active Facets profile: ${profile.name}\n${profile.instructions}`;
	else delete sections.facets_profile;
}
