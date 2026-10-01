import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildProfilesContext } from "./context.js";
import { loadProfiles, resolveProfile } from "./loader.js";
import { buildStartupSystemPrompt } from "./system-prompt.js";
import type { ResolvedProfile } from "./types.js";

export class StartupProfileRuntime {
	private active?: ResolvedProfile;
	private startupError?: string;
	private profilesContext = "";

	constructor(private readonly pi: ExtensionAPI) {}

	hasSystemPromptOverride(): boolean {
		return this.active?.systemPrompt !== undefined;
	}

	register(): void {
		this.pi.registerFlag("profile", {
			description: "Facets profile name to apply at process startup",
			type: "string",
		});

		this.pi.on("session_start", async (_event, ctx) => {
			this.profilesContext = buildProfilesContext(loadProfiles(ctx.cwd, ctx.isProjectTrusted()));
			const selected = this.pi.getFlag("profile");
			if (typeof selected !== "string" || !selected.trim()) {
				this.active = undefined;
				this.startupError = undefined;
				ctx.ui.setStatus("facets-profile", undefined);
				return;
			}
			try {
				this.active = resolveProfile(selected.trim(), ctx.cwd, ctx.isProjectTrusted());
				await this.apply(this.active, ctx);
				this.startupError = undefined;
				ctx.ui.setStatus("facets-profile", `profile:${this.active.name}`);
			} catch (error) {
				this.active = undefined;
				this.startupError = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(this.startupError, "error");
				if (!ctx.hasUI) console.error(`Facets profile error: ${this.startupError}`);
			}
		});

		this.pi.on("input", (_event, ctx) => {
			if (!this.startupError) return;
			ctx.ui.notify(`Cannot start agent: ${this.startupError}`, "error");
			return { action: "handled" as const };
		});

		this.pi.on("resources_discover", () => {
			if (!this.active?.resolvedSkills.length) return;
			return { skillPaths: this.active.resolvedSkills };
		});

		this.pi.on("before_agent_start", (event) => {
			const systemPrompt = buildStartupSystemPrompt(event.systemPrompt, this.active, this.profilesContext);
			return systemPrompt === undefined ? undefined : { systemPrompt };
		});

		this.pi.registerCommand("profiles", {
			description: "List startup profiles and their source",
			handler: async (_args, ctx) => {
				const catalog = loadProfiles(ctx.cwd, ctx.isProjectTrusted());
				const lines = [...catalog.profiles.values()]
					.sort((left, right) => left.name.localeCompare(right.name))
					.map((profile) => `${profile.name} (${profile.source})${profile.description ? ` — ${profile.description}` : ""}`);
				const diagnostics = catalog.diagnostics.map((item) => `${item.path}: ${item.message}`);
				ctx.ui.notify([
					lines.length > 0 ? lines.join("\n") : "No Facets profiles configured.",
					...(diagnostics.length > 0 ? [`Invalid profiles:\n${diagnostics.join("\n")}`] : []),
				].join("\n\n"), diagnostics.length > 0 ? "warning" : "info");
			},
		});
	}

	private async apply(profile: ResolvedProfile, ctx: ExtensionContext): Promise<void> {
		const allTools = new Set(this.pi.getAllTools().map((tool) => tool.name));
		const unknownTools = profile.tools.filter((tool) => !allTools.has(tool));
		if (unknownTools.length > 0) throw new Error(`Profile '${profile.name}' references unknown tools: ${unknownTools.join(", ")}.`);

		if (profile.model) {
			const separator = profile.model.indexOf("/");
			if (separator <= 0 || separator === profile.model.length - 1) {
				throw new Error(`Profile '${profile.name}' model must use provider/model format.`);
			}
			const model = ctx.modelRegistry.find(profile.model.slice(0, separator), profile.model.slice(separator + 1));
			if (!model) throw new Error(`Profile '${profile.name}' model '${profile.model}' is unavailable.`);
			if (!(await this.pi.setModel(model))) throw new Error(`Profile '${profile.name}' model '${profile.model}' has no usable credentials.`);
		}

		this.pi.setActiveTools(profile.tools);
		if (profile.thinkingLevel) {
			this.pi.setThinkingLevel(profile.thinkingLevel as ThinkingLevel);
			const effective = this.pi.getThinkingLevel();
			if (effective !== profile.thinkingLevel) {
				ctx.ui.notify(`Profile '${profile.name}' requested thinking '${profile.thinkingLevel}'; Pi selected '${effective}'.`, "warning");
			}
		}
	}
}
