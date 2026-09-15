import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveProfile } from "../profiles/loader.js";
import { resolveToolExtensions } from "../profiles/tool-sources.js";
import type { ParentRunManager } from "../run-manager.js";
import { talkView } from "../talk-render.js";

const MAX_OPEN_CHILDREN = 4;

function normalizeTitle(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || "delegated task";
}

function findChildTitle(manager: ParentRunManager, runId: unknown): string | undefined {
	if (typeof runId !== "string" || !runId) return;
	return (manager.runs.get(runId) ?? [...manager.runs.values()].find((run) => run.runId.startsWith(runId)))?.title;
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) {
		const hours = Math.floor(seconds / 3600);
		const minutes = Math.floor((seconds % 3600) / 60);
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	}
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3600);
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
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
		name: "create_child",
		label: "create child",
		description: "Create a fresh, context-isolated Child Pi in Herdr for a self-contained task. The Child remains open until the Parent calls close_child or the user closes it manually.",
		promptSnippet: "Create a focused Child Pi in Herdr with an explicit Facets profile",
		promptGuidelines: [
			"Use create_child for work assigned by PARENT.md or a separable task that benefits from an independent context; select an explicitly configured profile and provide a short informative title.",
			"After create_child launches, do not wait or repeatedly poll. Facets will wake the Parent when the Child uses talk.",
			"Use talk to respond to an existing Child or give it more work, and use close_child only after its delivery is accepted or the user asks to close it.",
		],
		parameters: Type.Object({
			title: Type.String({ description: "Short Herdr tab title, up to 48 displayed characters." }),
			task: Type.String({ description: "Self-contained initial task. Do not assume the Child can see the Parent conversation." }),
			profile: Type.String({ description: "Configured Facets profile name. Project profiles override same-named global profiles." }),
			cwd: Type.Optional(Type.String({ description: "Child working directory; defaults to the Parent cwd." })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			if (manager.runs.size >= MAX_OPEN_CHILDREN) throw new Error(`Facets allows at most ${MAX_OPEN_CHILDREN} open children.`);
			const title = normalizeTitle(params.title);
			const cwd = path.resolve(ctx.cwd, params.cwd ?? ".");
			const profile = resolveToolExtensions(
				resolveProfile(params.profile, ctx.cwd, ctx.isProjectTrusted()),
				pi.getAllTools(),
			);
			const sessionPersistence = profile.sessionPersistence ?? "ephemeral";
			const capabilityDetails = { tools: profile.tools, skills: profile.skills ?? [], sessionPersistence };
			onUpdate?.({
				content: [{ type: "text", text: `Creating Child with profile ${profile.name}: ${title}` }],
				details: { title, profile: profile.name, ...capabilityDetails },
			});
			const run = await manager.create({ title, task: params.task, cwd, profile }, signal);
			return {
				content: [{ type: "text", text: `Created Child: ${run.title} (profile ${run.profileName}, run ${run.runId.slice(0, 8)}).` }],
				details: {
					runId: run.runId,
					title: run.title,
					profile: run.profileName,
					adapter: run.surface?.adapter,
					...capabilityDetails,
				},
				terminate: true,
			};
		},
		renderCall(args, theme) {
			const title = normalizeTitle(args.title ?? "delegated task");
			return new Text(`${theme.fg("toolTitle", theme.bold("delegate"))} ${theme.fg("muted", `· ${title}`)}`, 0, 0);
		},
		renderResult(result, { isPartial }, theme) {
			const details = result.details as {
				title?: string;
				profile?: string;
				adapter?: string;
				tools?: string[];
				skills?: string[];
				sessionPersistence?: string;
			} | undefined;
			const icon = isPartial ? theme.fg("warning", "◌") : theme.fg("success", "✓");
			const summary = `${icon} ${theme.fg("accent", details?.title ?? "child")} ${theme.fg("muted", `· ${details?.profile ?? "profile?"} · ${details?.sessionPersistence ?? "ephemeral"}${details?.adapter ? ` · ${details.adapter}` : ""}`)}`;
			const tools = `${theme.fg("dim", "  tools ")}${theme.fg("muted", compactCapabilityList(details?.tools ?? []))}`;
			const skills = `${theme.fg("dim", "  skills")}${theme.fg("muted", ` ${compactCapabilityList(details?.skills ?? [])}`)}`;
			return new Text(`${summary}\n${tools}\n${skills}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "talk",
		label: "talk",
		description: "Send one message to an existing Child Pi. The Child receives queued messages in order when it is idle. Format non-trivial messages as readable Markdown with paragraph breaks and lists.",
		promptSnippet: "Send a message to an existing Child Pi",
		executionMode: "sequential",
		parameters: Type.Object({
			runId: Type.String({ description: "Full Child run ID or a unique prefix." }),
			message: Type.String({ description: "Message to the other Agent. For non-trivial content, use readable Markdown with paragraph breaks and lists." }),
		}),
		renderCall(args, theme, context) {
			const message = typeof args.message === "string" ? args.message : "";
			const title = findChildTitle(manager, args.runId);
			const suffix = title ? ` ${theme.fg("muted", `· ${title}`)}` : "";
			const view = talkView(message, context.expanded);
			let text = `${theme.fg("accent", "›")} ${theme.fg("toolTitle", theme.bold("message send"))}${suffix}`;
			if (message) text += `\n\n${view.lines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
			if (view.remaining > 0) {
				text += theme.fg("muted", `\n... (${view.remaining} more lines, ${view.totalLines} total, ctrl+o to expand)`);
			}
			return new Text(text, 0, 0);
		},
		async execute(_id, params) {
			const { run, messageId } = manager.talk(params.runId, params.message);
			return {
				content: [{ type: "text", text: `Message delivered to Child: ${run.title}` }],
				details: { runId: run.runId, messageId },
			};
		},
		renderResult(_result, _options, theme, context) {
			if (context.isError) return new Text(theme.fg("error", "\ntalk failed"), 0, 0);
			return new Container();
		},
	});

	pi.registerTool({
		name: "close_child",
		label: "close child",
		description: "Close a Child Pi session and its Herdr tab. Use after the delivery is accepted or when the user asks to close it.",
		parameters: Type.Object({
			runId: Type.String({ description: "Full Child run ID or a unique prefix." }),
			reason: Type.Optional(Type.String({ description: "Reason for closing the Child session." })),
		}),
		renderCall(args, theme, context) {
			const state = context.state as { title?: string };
			state.title ??= findChildTitle(manager, args.runId);
			return new Text(`${theme.fg("toolTitle", theme.bold("close"))} ${theme.fg("muted", `· ${state.title ?? "child"}`)}`, 0, 0);
		},
		async execute(_id, params) {
			const run = await manager.close(params.runId, params.reason ?? "The Parent closed the Child session.");
			return { content: [{ type: "text", text: `Closed Child: ${run.title}` }], details: { runId: run.runId } };
		},
		renderResult(_result, _options, theme, context) {
			if (context.isError) return new Text(theme.fg("error", "\nclose failed"), 0, 0);
			return new Container();
		},
	});

	pi.registerTool({
		name: "list_child",
		label: "list child",
		description: "List open Child sessions with bounded metadata. Never returns transcripts.",
		parameters: Type.Object({}),
		async execute() {
			const now = Date.now();
			const runs = [...manager.runs.values()].map((run) => ({
				runId: run.runId,
				title: run.title,
				profile: run.profileName,
				sessionPersistence: run.sessionPersistence,
				adapter: run.surface?.adapter,
				elapsedSeconds: Math.max(0, Math.round((now - run.createdAt) / 1000)),
			}));
			const text = runs.length
				? runs.map((run) => `- ${run.runId.slice(0, 8)} ${run.title} <${run.profile}, ${run.sessionPersistence}> (${formatElapsed(run.elapsedSeconds)})`).join("\n")
				: "no open child sessions.";
			return { content: [{ type: "text", text }], details: { runs } };
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("children")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { runs?: Array<{
				runId: string;
				title: string;
				profile: string;
				sessionPersistence: string;
				adapter?: string;
				elapsedSeconds: number;
			}> } | undefined;
			const runs = details?.runs ?? [];
			if (runs.length === 0) return new Text(theme.fg("muted", "no open child sessions"), 0, 0);
			const lines = runs.map((run) => {
				const metadata = [
					run.runId.slice(0, 8),
					run.profile,
					run.sessionPersistence,
					run.adapter,
					formatElapsed(run.elapsedSeconds),
				].filter(Boolean).join(" · ");
				return `${theme.fg("accent", "•")} ${theme.fg("accent", run.title)}\n  ${theme.fg("muted", metadata)}`;
			});
			return new Text(lines.join("\n\n"), 0, 0);
		},
	});
}
