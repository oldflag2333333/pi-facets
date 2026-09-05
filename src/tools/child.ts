import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	createQuestion,
	readCancel,
	readManifest,
	readReply,
	resultExists,
	writeResult,
} from "../channel.js";
import type { DelegateManifest, DelegateResult } from "../types.js";

const channelDir = process.env.PI_FACETS_CHANNEL;
const envToken = process.env.PI_FACETS_TOKEN;

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Cancelled while waiting for the parent."));
		const timer = setTimeout(resolve, ms);
		const abort = () => {
			clearTimeout(timer);
			reject(new Error("Cancelled while waiting for the parent."));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function loadManifest(): { channelDir: string; manifest: DelegateManifest } {
	if (!channelDir) throw new Error("PI_FACETS_CHANNEL is missing in child Pi.");
	const manifest = readManifest(channelDir);
	if (!envToken || envToken !== manifest.token) throw new Error("Child channel capability token does not match.");
	return { channelDir, manifest };
}

function finalAssistant(ctx: ExtensionContext): { text: string; failed: boolean; error?: string } {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const text = entry.message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim();
		return {
			text,
			failed: entry.message.stopReason === "error" || entry.message.stopReason === "aborted",
			error: entry.message.errorMessage,
		};
	}
	return { text: "", failed: true, error: "Child ended without an assistant response." };
}

export function registerChild(pi: ExtensionAPI): void {
	const loaded = loadManifest();
	let submitted = resultExists(loaded.channelDir);
	let cancelPoller: ReturnType<typeof setInterval> | undefined;

	pi.on("session_start", (_event, ctx) => {
		pi.setSessionName(`[sub] ${loaded.manifest.title}`);
		ctx.ui.setTitle(`[sub] ${loaded.manifest.title}`);
		ctx.ui.setStatus("facets", `child · ${loaded.manifest.profile.name}`);
		cancelPoller = setInterval(() => {
			if (!readCancel(loaded.channelDir, loaded.manifest)) return;
			ctx.abort();
			ctx.shutdown();
		}, 500);
		cancelPoller.unref?.();
	});

	pi.on("before_agent_start", (event) => {
		const profileInstructions = loaded.manifest.profile.instructions
			? `\n\n## Facets profile: ${loaded.manifest.profile.name}\n${loaded.manifest.profile.instructions}`
			: "";
		return {
			systemPrompt: `${event.systemPrompt}\n\n## Delegated child protocol\nYou are an isolated child Pi working for a parent Pi. You have not received the parent's conversation and must not attempt to read Pi session files. Work only from the delegated task, project files, and explicit replies. If a missing decision prevents safe progress, call ask_parent; do not ask through ordinary assistant text. Communication with the parent is limited to questions and one final result. When finished, call return_to_parent exactly once with a concise, self-contained result. Do not claim the parent has context you were not explicitly given.${profileInstructions}`,
		};
	});

	pi.registerTool({
		name: "ask_parent",
		label: "Ask Parent",
		description: "Ask the parent Pi one blocking question and wait for its bounded reply. Use only when a missing decision prevents safe progress.",
		promptSnippet: "Ask the parent Pi a blocking clarification question",
		promptGuidelines: ["Use ask_parent rather than guessing when the delegated task requires a decision only the parent can make."],
		executionMode: "sequential",
		parameters: Type.Object({
			question: Type.String({ description: "A self-contained question for the parent." }),
			choices: Type.Optional(Type.Array(Type.String(), { maxItems: 8, description: "Optional concrete choices." })),
			recommendation: Type.Optional(Type.String({ description: "Optional recommended answer and brief rationale." })),
		}),
		async execute(_id, params, signal) {
			if (submitted) throw new Error("The final result has already been submitted.");
			const request = createQuestion(loaded.channelDir, loaded.manifest, params);
			for (;;) {
				if (readCancel(loaded.channelDir, loaded.manifest)) throw new Error("The parent cancelled this delegated task.");
				const reply = readReply(loaded.channelDir, loaded.manifest, request.requestId);
				if (reply) {
					return {
						content: [{ type: "text", text: `Reply from parent:\n${reply.answer}` }],
						details: { requestId: request.requestId },
					};
				}
				await delay(250, signal);
			}
		},
	});

	pi.registerTool({
		name: "return_to_parent",
		label: "Return to Parent",
		description: "Submit the one final bounded task result to the parent Pi. This is a result handoff, not a transcript export.",
		promptSnippet: "Return the final delegated result to the parent Pi",
		promptGuidelines: ["Call return_to_parent exactly once when the delegated task is complete or cannot be completed."],
		executionMode: "sequential",
		parameters: Type.Object({
			status: StringEnum(["completed", "failed"] as const),
			summary: Type.String({ description: "Self-contained final result, including important evidence and conclusions." }),
			changedFiles: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
			artifacts: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
			nextSteps: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
			error: Type.Optional(Type.String()),
		}),
		async execute(_id, params) {
			if (submitted) throw new Error("The final result has already been submitted.");
			const result: DelegateResult = {
				version: 1,
				type: "result",
				runId: loaded.manifest.runId,
				token: loaded.manifest.token,
				createdAt: Date.now(),
				...params,
			};
			writeResult(loaded.channelDir, result);
			submitted = true;
			return {
				content: [{ type: "text", text: "Final result delivered to the parent Pi." }],
				details: { runId: loaded.manifest.runId, status: params.status },
				terminate: true,
			};
		},
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (submitted) return;
		const final = finalAssistant(ctx);
		const result: DelegateResult = {
			version: 1,
			type: "result",
			runId: loaded.manifest.runId,
			token: loaded.manifest.token,
			createdAt: Date.now(),
			status: final.failed ? "failed" : "completed",
			summary: final.text || final.error || "Child Pi ended without a final result.",
			...(final.error ? { error: final.error } : {}),
		};
		writeResult(loaded.channelDir, result);
		submitted = true;
	});

	pi.on("session_shutdown", () => {
		if (cancelPoller) clearInterval(cancelPoller);
		cancelPoller = undefined;
	});
}
