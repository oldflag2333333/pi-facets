import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ParentContextRuntime } from "./parent-context.js";
import { StartupProfileRuntime } from "./profiles/runtime.js";
import { ParentRunManager, NOTICE_TYPE } from "./run-manager.js";
import { registerChild } from "./tools/child.js";
import { registerParentTools } from "./tools/parent.js";

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "Facets update";
	return content.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "").filter(Boolean).join("\n");
}

export default function piDelegate(pi: ExtensionAPI): void {
	if (process.env.PI_FACETS_ROLE === "child") {
		registerChild(pi);
		return;
	}

	const manager = new ParentRunManager(pi);
	registerParentTools(pi, manager);
	new StartupProfileRuntime(pi).register();
	new ParentContextRuntime(pi).register();

	pi.registerMessageRenderer(NOTICE_TYPE, (message, _options, theme) => {
		return new Text(`${theme.fg("accent", "•")} ${theme.fg("muted", contentText(message.content))}`, 0, 0);
	});

	pi.on("session_start", (_event, ctx) => manager.start(ctx));

	pi.on("context", (event) => {
		const injected = manager.contextMessages();
		if (injected.length === 0) return;
		return { messages: [...event.messages, ...injected] };
	});

	pi.on("agent_settled", () => manager.settled());

	pi.on("session_shutdown", () => manager.shutdown());
}
