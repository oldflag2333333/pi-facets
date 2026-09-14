import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	listTalkToChild,
	readClose,
	readManifest,
	removeTalk,
	talkToParent,
	writeChildClosed,
} from "../channel.js";
import { buildChildSystemPrompt } from "../profiles/system-prompt.js";
import { talkView } from "../talk-render.js";
import type { DelegateManifest } from "../types.js";

const channelDir = process.env.PI_FACETS_CHANNEL;
const envToken = process.env.PI_FACETS_TOKEN;

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "")
		.filter(Boolean)
		.join("\n");
}

function loadManifest(): { channelDir: string; manifest: DelegateManifest } {
	if (!channelDir) throw new Error("PI_FACETS_CHANNEL is missing in child Pi.");
	const manifest = readManifest(channelDir);
	if (!envToken || envToken !== manifest.token) throw new Error("Child channel capability token does not match.");
	return { channelDir, manifest };
}

export function registerChild(pi: ExtensionAPI): void {
	const loaded = loadManifest();
	let delivering = false;
	let protocolPoller: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", (_event, ctx) => {
		pi.setSessionName(`[sub] ${loaded.manifest.title}`);
		ctx.ui.setTitle(`[sub] ${loaded.manifest.title}`);
		ctx.ui.setStatus("facets", `child · ${loaded.manifest.profile.name}`);
		protocolPoller = setInterval(() => {
			if (readClose(loaded.channelDir, loaded.manifest)) {
				ctx.abort();
				ctx.shutdown();
				return;
			}
			if (delivering || !ctx.isIdle()) return;
			const message = listTalkToChild(loaded.channelDir, loaded.manifest)[0];
			if (!message) return;
			delivering = true;
			try {
				pi.sendUserMessage(message.message);
				removeTalk(loaded.channelDir, "to-child", message.id);
			} catch (error) {
				removeTalk(loaded.channelDir, "to-child", message.id);
				talkToParent(
					loaded.channelDir,
					loaded.manifest,
					`Unable to process the Parent message: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				delivering = false;
			}
		}, 400);
		protocolPoller.unref?.();
	});

	pi.on("before_agent_start", (event) => {
		return { systemPrompt: buildChildSystemPrompt(event.systemPrompt, loaded.manifest.profile) };
	});

	pi.registerTool({
		name: "talk",
		label: "talk",
		description: "Send one message to the Parent Pi and end the current turn. Use it to ask for information or deliver work. Format non-trivial messages as readable Markdown with paragraph breaks and lists.",
		promptSnippet: "Send a message to the Parent Pi",
		promptGuidelines: ["Use talk whenever the child needs to communicate with the Parent; the Parent decides when to close the child session."],
		executionMode: "sequential",
		parameters: Type.Object({
			message: Type.String({ description: "Message to the other Agent. For non-trivial content, use readable Markdown with paragraph breaks and lists." }),
		}),
		renderCall(args, theme, context) {
			const message = typeof args.message === "string" ? args.message : "";
			const view = talkView(message, context.expanded);
			let text = `${theme.fg("accent", "›")} ${theme.fg("toolTitle", theme.bold("message to parent"))} ${theme.fg("muted", `· ${loaded.manifest.title}`)}`;
			if (message) text += `\n\n${view.lines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
			if (view.remaining > 0) {
				text += theme.fg("muted", `\n... (${view.remaining} more lines, ${view.totalLines} total, ctrl+o to expand)`);
			}
			return new Text(text, 0, 0);
		},
		async execute(_id, params) {
			const message = talkToParent(loaded.channelDir, loaded.manifest, params.message);
			return {
				content: [{ type: "text", text: "Message delivered to the Parent Pi." }],
				details: { messageId: message.id },
				terminate: true,
			};
		},
		renderResult(result, _options, theme, context) {
			if (context.isError) return new Text(`\n${theme.fg("error", contentText(result.content) || "talk failed")}`, 0, 0);
			return new Container();
		},
	});

	pi.on("session_shutdown", (event) => {
		if (protocolPoller) clearInterval(protocolPoller);
		protocolPoller = undefined;
		if (event.reason === "quit" && !readClose(loaded.channelDir, loaded.manifest)) {
			writeChildClosed(loaded.channelDir, loaded.manifest, "The child session was closed manually.");
		}
	});
}
