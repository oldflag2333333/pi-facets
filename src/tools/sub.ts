import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	listTalkToSub,
	MESSAGE_TYPE,
	readClose,
	readManifest,
	removeTalk,
	talkToMain,
	writeSubClosed,
	writeSubSessionInfo,
} from "../channel.js";
import { buildSubSystemPrompt } from "../profiles/system-prompt.js";
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
	if (!channelDir) throw new Error("PI_FACETS_CHANNEL is missing in Sub Pi.");
	const manifest = readManifest(channelDir);
	if (!envToken || envToken !== manifest.token) throw new Error("Sub channel capability token does not match.");
	return { channelDir, manifest };
}

export function registerSub(pi: ExtensionAPI): void {
	const loaded = loadManifest();
	let delivering = false;
	let protocolPoller: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", (_event, ctx) => {
		pi.setSessionName(`[sub] ${loaded.manifest.title}`);
		ctx.ui.setTitle(`[sub] ${loaded.manifest.title}`);
		ctx.ui.setStatus("facets", `sub · ${loaded.manifest.profile.name}`);
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (loaded.manifest.profile.sessionPersistence === "persistent" && sessionFile) {
			writeSubSessionInfo(loaded.channelDir, loaded.manifest, {
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile,
			});
		}
		protocolPoller = setInterval(() => {
			if (readClose(loaded.channelDir, loaded.manifest)) {
				ctx.abort();
				ctx.shutdown();
				return;
			}
			if (delivering || !ctx.isIdle()) return;
			const message = listTalkToSub(loaded.channelDir, loaded.manifest)[0];
			if (!message) return;
			delivering = true;
			try {
				pi.sendMessage({
					customType: MESSAGE_TYPE,
					content: `[Facets Main message]\nMain says:\n${message.message}`,
					display: true,
					details: { title: loaded.manifest.title, message: message.message },
				}, { deliverAs: "followUp", triggerTurn: true });
				removeTalk(loaded.channelDir, "to-sub", message.id);
			} catch (error) {
				removeTalk(loaded.channelDir, "to-sub", message.id);
				talkToMain(
					loaded.channelDir,
					loaded.manifest,
					`Unable to process the Main message: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				delivering = false;
			}
		}, 400);
		protocolPoller.unref?.();
	});

	pi.on("before_agent_start", (event) => {
		return { systemPrompt: buildSubSystemPrompt(event.systemPrompt, loaded.manifest.profile) };
	});

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details as { title?: string; message?: string } | undefined;
		const title = details?.title ?? loaded.manifest.title;
		const mainMessage = details?.message ?? "";
		const view = talkView(mainMessage, options.expanded);
		let text = `${theme.fg("accent", "›")} ${theme.fg("toolTitle", theme.bold("message inbox"))} ${theme.fg("muted", `· ${title}`)}`;
		if (mainMessage) text += `\n\n${view.lines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (view.remaining > 0) {
			text += theme.fg("muted", `\n... (${view.remaining} more lines, ${view.totalLines} total, ctrl+o to expand)`);
		}
		const box = new Box(1, 1, (line) => theme.bg("toolSuccessBg", line));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	pi.registerTool({
		name: "talk",
		label: "talk",
		description: "Send one message to the Main Pi and end the current turn. Use it to ask for information or deliver work. Format non-trivial messages as readable Markdown with paragraph breaks and lists.",
		promptSnippet: "Send a message to the Main Pi",
		promptGuidelines: ["Use talk whenever the Sub needs to communicate with the Main; the Main decides when to close the Sub session."],
		executionMode: "sequential",
		parameters: Type.Object({
			message: Type.String({ description: "Message to the other Agent. For non-trivial content, use readable Markdown with paragraph breaks and lists." }),
		}),
		renderCall(args, theme, context) {
			const message = typeof args.message === "string" ? args.message : "";
			const view = talkView(message, context.expanded);
			let text = `${theme.fg("accent", "›")} ${theme.fg("toolTitle", theme.bold("message send"))} ${theme.fg("muted", `· ${loaded.manifest.title}`)}`;
			if (message) text += `\n\n${view.lines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
			if (view.remaining > 0) {
				text += theme.fg("muted", `\n... (${view.remaining} more lines, ${view.totalLines} total, ctrl+o to expand)`);
			}
			return new Text(text, 0, 0);
		},
		async execute(_id, params) {
			const message = talkToMain(loaded.channelDir, loaded.manifest, params.message);
			return {
				content: [{ type: "text", text: "Message delivered to the Main Pi." }],
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
			writeSubClosed(loaded.channelDir, loaded.manifest, "The Sub session was closed manually.");
		}
	});
}
