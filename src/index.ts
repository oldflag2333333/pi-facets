import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { MESSAGE_TYPE } from "./channel.js";
import { ParentContextRuntime } from "./parent-context.js";
import { StartupProfileRuntime } from "./profiles/runtime.js";
import { ParentRunManager } from "./run-manager.js";
import { registerChild } from "./tools/child.js";
import { talkView } from "./talk-render.js";
import { registerParentTools } from "./tools/parent.js";

export default function piDelegate(pi: ExtensionAPI): void {
	if (process.env.PI_FACETS_ROLE === "child") {
		registerChild(pi);
		return;
	}

	const manager = new ParentRunManager(pi);
	const startupProfile = new StartupProfileRuntime(pi);
	registerParentTools(pi, manager);
	startupProfile.register();
	new ParentContextRuntime(pi, () => !startupProfile.hasSystemPromptOverride()).register();

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details as { title?: string; message?: string } | undefined;
		const title = details?.title ?? "Child";
		const childMessage = details?.message ?? "";
		const view = talkView(childMessage, options.expanded);
		let text = `${theme.fg("accent", "›")} ${theme.fg("toolTitle", theme.bold("message inbox"))} ${theme.fg("muted", `· ${title}`)}`;
		if (childMessage) text += `\n\n${view.lines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (view.remaining > 0) {
			text += theme.fg("muted", `\n... (${view.remaining} more lines, ${view.totalLines} total, ctrl+o to expand)`);
		}
		const box = new Box(1, 1, (line) => theme.bg("toolSuccessBg", line));
		box.addChild(new Text(text, 0, 0));
		return box;
	});
	pi.on("session_start", (_event, ctx) => manager.start(ctx));

	pi.on("session_shutdown", () => manager.shutdown());
}
