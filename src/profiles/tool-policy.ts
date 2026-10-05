import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Active tools control declarations, not the callable set of deferred tools. */
export class ProfileToolPolicy {
	private allowed?: Set<string>;
	private profileName?: string;
	private error?: string;

	constructor(pi: ExtensionAPI) {
		pi.on("tool_call", (event) => {
			if (this.error) return { block: true, reason: this.error };
			if (this.allowed && !this.allowed.has(event.toolName)) {
				return { block: true, reason: `Tool '${event.toolName}' is not allowed by Facets profile '${this.profileName}'.` };
			}
		});
	}

	clear(): void {
		this.allowed = undefined;
		this.profileName = undefined;
		this.error = undefined;
	}

	denyAll(reason: string): void {
		this.error = reason;
	}

	allow(profileName: string, tools: readonly string[]): void {
		this.profileName = profileName;
		this.allowed = new Set(tools);
		this.error = undefined;
	}
}

export function applyProfileTools(pi: ExtensionAPI, profileName: string, tools: readonly string[]): void {
	const available = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	const unavailable = tools.filter((name) => !available.has(name) || available.get(name)?.exposure === "hidden");
	if (unavailable.length > 0) {
		throw new Error(`Profile '${profileName}' references unavailable tools: ${unavailable.join(", ")}.`);
	}
	pi.setActiveTools([...tools]);
	const active = new Set(pi.getActiveTools());
	const missing = tools.filter((name) => !active.has(name));
	if (missing.length > 0) {
		throw new Error(`Profile '${profileName}' could not activate tools: ${missing.join(", ")}.`);
	}
}
