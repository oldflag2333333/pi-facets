import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveProfile } from "../profiles/loader.js";
import { resolveToolExtensions } from "../profiles/tool-sources.js";
import type { ParentRunManager } from "../run-manager.js";

const MAX_CONCURRENT = 4;

function active(state: string): boolean {
	return state === "starting" || state === "running" || state === "waiting_parent";
}

function normalizeTitle(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || "delegated task";
}

function compactCapabilityList(values: string[], maxCharacters = 160): string {
	if (values.length === 0) return "(none)";
	const visible: string[] = [];
	let length = 0;
	for (const value of values) {
		const addition = (visible.length > 0 ? 3 : 0) + value.length;
		if (length + addition > maxCharacters) {
			if (visible.length === 0) visible.push(`${value.slice(0, Math.max(1, maxCharacters - 1))}…`);
			break;
		}
		visible.push(value);
		length += addition;
	}
	const omitted = values.length - visible.length;
	return `${visible.join(" · ")}${omitted > 0 ? ` · +${omitted}` : ""}`;
}

export function registerParentTools(pi: ExtensionAPI, manager: ParentRunManager): void {
	pi.registerTool({
		name: "delegate_pi",
		label: "Facets Delegate",
		description: "Delegate a self-contained task to a fresh, context-isolated child Pi. Returns after launch; questions and the bounded final result arrive asynchronously. The child never receives the parent conversation.",
		promptSnippet: "Delegate focused work to a fresh isolated child Pi",
		promptGuidelines: [
			"Use delegate_pi for a separable task that benefits from an independent context; select an explicitly configured profile and give it a self-contained task and a short informative title.",
			"After delegate_pi launches, do not wait or repeatedly poll. Continue useful parent work or tell the user delegation is running; Facets will wake this session for questions and completion.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short tab title describing the child task (max 48 displayed characters)." }),
			task: Type.String({ description: "Self-contained delegated task. Do not assume the child can see this conversation." }),
			profile: Type.String({ description: "Configured Facets profile name. Project profiles override same-named global profiles." }),
			cwd: Type.Optional(Type.String({ description: "Child working directory; defaults to the parent cwd." })),
			adapter: Type.Optional(StringEnum(["auto", "herdr", "headless"] as const, { description: "auto prefers a Herdr tab and falls back to a headless child." })),
			closeOnTerminal: Type.Optional(Type.Boolean({ description: "Close the child surface when it completes or fails. Default: true." })),
			timeoutMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440, description: "Overall child deadline in minutes. Default: 30." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const running = [...manager.runs.values()].filter((run) => active(run.state)).length;
			if (running >= MAX_CONCURRENT) throw new Error(`Facets allows at most ${MAX_CONCURRENT} concurrent children.`);
			const title = normalizeTitle(params.title);
			const cwd = path.resolve(ctx.cwd, params.cwd ?? ".");
			const profile = resolveToolExtensions(
				resolveProfile(params.profile, ctx.cwd, ctx.isProjectTrusted()),
				pi.getAllTools(),
			);
			const capabilityDetails = { tools: profile.tools, skills: profile.skills ?? [] };
			onUpdate?.({
				content: [{ type: "text", text: `Launching subagent with profile ${profile.name}: ${title}` }],
				details: { state: "starting", title, profile: profile.name, ...capabilityDetails },
			});
			const run = await manager.delegate({
				title,
				task: params.task,
				cwd,
				profile,
				adapter: params.adapter ?? "auto",
				closeOnTerminal: params.closeOnTerminal ?? true,
				timeoutMinutes: params.timeoutMinutes ?? 30,
			}, signal);
			return {
				content: [{ type: "text", text: `Delegated to subagent: ${run.title} (profile ${run.profileName}, ${run.surface?.adapter}, run ${run.runId.slice(0, 8)}). Questions and results will return automatically.` }],
				details: {
					runId: run.runId,
					title: run.title,
					profile: run.profileName,
					state: run.state,
					adapter: run.surface?.adapter,
					...capabilityDetails,
				},
			};
		},
		renderCall(args, theme) {
			const profile = typeof args.profile === "string" ? ` ${theme.fg("muted", `· ${args.profile}`)}` : "";
			return new Text(`${theme.fg("toolTitle", theme.bold("↗ Subagent"))} ${theme.fg("accent", normalizeTitle(args.title ?? "delegated task"))}${profile}`, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			const details = result.details as {
				title?: string;
				profile?: string;
				state?: string;
				adapter?: string;
				tools?: string[];
				skills?: string[];
			} | undefined;
			const icon = isPartial ? theme.fg("warning", "◌") : theme.fg("success", "✓");
			const state = details?.state ?? (isPartial ? "starting" : "running");
			const summary = `${icon} ${theme.fg("accent", details?.title ?? "Subtask")} ${theme.fg("muted", `· ${details?.profile ?? "profile?"} · ${state}${details?.adapter ? ` · ${details.adapter}` : ""}`)}`;
			const tools = `${theme.fg("dim", "  tools ")}${theme.fg("muted", compactCapabilityList(details?.tools ?? []))}`;
			const skills = `${theme.fg("dim", "  skills")}${theme.fg("muted", ` ${compactCapabilityList(details?.skills ?? [])}`)}`;
			return new Text(`${summary}\n${tools}\n${skills}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "reply_child",
		label: "Reply Child",
		description: "Answer exactly one pending question from a delegated child Pi. It cannot send unsolicited instructions.",
		promptSnippet: "Reply to a pending delegated-child question",
		promptGuidelines: ["When a Facets supervisor request is injected, answer it with reply_child using the exact requestId."],
		executionMode: "sequential",
		parameters: Type.Object({
			requestId: Type.String({ description: "Exact pending question ID." }),
			answer: Type.String({ description: "Self-contained answer to that question only." }),
		}),
		async execute(_id, params) {
			const pending = manager.reply(params.requestId, params.answer);
			return {
				content: [{ type: "text", text: `Replied to subagent: ${pending.run.title}` }],
				details: { requestId: params.requestId, runId: pending.run.runId },
			};
		},
	});

	pi.registerTool({
		name: "cancel_child",
		label: "Cancel Child",
		description: "Cancel one delegated child and close its surface.",
		parameters: Type.Object({
			runId: Type.String({ description: "Full run ID or a unique prefix." }),
			reason: Type.Optional(Type.String({ description: "Cancellation reason sent to the child." })),
		}),
		async execute(_id, params) {
			const run = await manager.cancel(params.runId, params.reason ?? "Cancelled by parent Pi.");
			return { content: [{ type: "text", text: `Cancelled subagent: ${run.title}` }], details: { runId: run.runId, state: run.state } };
		},
	});

	pi.registerTool({
		name: "list_children",
		label: "List Children",
		description: "List bounded child metadata (ID, title, state, elapsed time). Never returns child transcripts.",
		parameters: Type.Object({}),
		async execute() {
			const now = Date.now();
			const runs = [...manager.runs.values()].map((run) => ({
				runId: run.runId,
				title: run.title,
				state: run.state,
				profile: run.profileName,
				adapter: run.surface?.adapter,
				elapsedSeconds: Math.max(0, Math.round((now - run.createdAt) / 1000)),
			}));
			const text = runs.length ? runs.map((run) => `- ${run.runId.slice(0, 8)} [${run.state}] ${run.title} <${run.profile}> (${run.elapsedSeconds}s)`).join("\n") : "No delegated children.";
			return { content: [{ type: "text", text }], details: { runs } };
		},
	});
}
