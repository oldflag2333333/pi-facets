import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createAssistantMessageEventStream, getCurrentSystemMessage, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createChannel, MESSAGE_TYPE, readManifest, talkToMain } from "../src/channel.js";
import { bindPromptSections } from "../src/profiles/system-prompt.js";
import { MainRunManager, RUN_ENTRY } from "../src/run-manager.js";

async function until(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 2500;
	while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.ok(condition(), "Timed out waiting for queue transition");
}

async function fixture(root: string) {
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	const requests: TranscriptContext[] = [];
	const errors: unknown[] = [];
	let manager: MainRunManager;
	let context: ExtensionContext;
	let finishFirst: (() => void) | undefined;
	const ui = { notify: () => {}, setStatus: () => {}, setTitle: () => {} } as unknown as ExtensionUIContext;
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
		extensionFactories: [(pi) => {
			pi.registerProvider("queue-fixture", {
				api: "queue-fixture-api", apiKey: "fixture-only", baseUrl: "https://fixture.invalid",
				models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
				streamSimple: (model, value, options) => {
					requests.push(structuredClone(value));
					const stream = createAssistantMessageEventStream();
					let finished = false;
					const finish = (aborted = false) => {
						if (finished) return;
						finished = true;
						const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
							content: [], stopReason: "pending", timestamp: Date.now(),
							usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						};
						stream.push({ type: "start", partial: structuredClone(message) });
						if (aborted) {
							message.stopReason = "aborted";
							message.errorMessage = "Cancelled";
							stream.push({ type: "error", reason: "aborted", error: message });
						} else {
							message.content = [{ type: "text", text: "" }];
							stream.push({ type: "text_start", contentIndex: 0, partial: structuredClone(message) });
							message.content = [{ type: "text", text: "ok" }];
							stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: structuredClone(message) });
							stream.push({ type: "text_end", contentIndex: 0, content: "ok", partial: structuredClone(message) });
							message.stopReason = "stop";
							stream.push({ type: "done", reason: "stop", message });
						}
						stream.end(message);
					};
					if (requests.length === 1) {
						finishFirst = () => finish();
						options?.signal?.addEventListener("abort", () => finish(true), { once: true });
					} else finish();
					return stream;
				},
			});
			bindPromptSections(pi, ["facets_fixture"], () => ({ facets_fixture: "Fixture role instructions" }));
			manager = new MainRunManager(pi);
			pi.on("session_start", (_event, ctx) => { context = ctx; manager.start(ctx); });
			pi.on("session_shutdown", () => manager.shutdown());
		}],
	});
	await resourceLoader.reload();
	const modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader, settingsManager, modelRuntime, sessionManager: SessionManager.inMemory(root), tools: ["read"] });
	await session.bindExtensions({ mode: "tui", uiContext: ui, onError: (error) => errors.push(error) });
	const model = modelRuntime.getModel("queue-fixture", "fixture");
	assert.ok(model);
	await session.setModel(model);
	const channel = createChannel({ runId: "run", mainSessionId: session.sessionManager.getSessionId(), title: "Review", task: "Review", cwd: root,
		profile: { version: 1, name: "reviewer", tools: ["read"], source: "global", sourcePath: "/tmp/profile.json", resolvedSkills: [], resolvedExtensions: [] },
	});
	const run = { version: 1 as const, runId: channel.runId, mainSessionId: channel.mainSessionId, title: channel.title, cwd: root, profileName: "reviewer", sessionPersistence: "ephemeral" as const,
		channelDir: channel.channelDir, createdAt: channel.createdAt, updatedAt: channel.createdAt, surface: { adapter: "herdr" as const, tabId: "tab" },
	};
	manager!.runs.set(run.runId, run);
	session.sessionManager.appendCustomEntry(RUN_ENTRY, { ...run });
	manager!.start(context!);
	return { session, channel, requests, errors,
		rescan: () => manager.start(context), finish: () => finishFirst!(),
		stop: () => manager.shutdown(),
		inboxEntries: () => session.sessionManager.getEntries().filter((entry) => entry.type === "custom_message" && entry.customType === MESSAGE_TYPE),
	};
}

for (const mode of ["reload", "cancel-clear"]) {
	test(`real Pi queue recovery: ${mode}`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "facets-queue-sdk-"));
		const previous = process.env.XDG_RUNTIME_DIR;
		process.env.XDG_RUNTIME_DIR = root;
		let f: Awaited<ReturnType<typeof fixture>> | undefined;
		let initial: Promise<unknown> | undefined;
		try {
			f = await fixture(root);
			initial = f.session.prompt("Current Main task");
			await until(() => f!.requests.length === 1);
			const message = talkToMain(f.channel.channelDir, readManifest(f.channel.channelDir), "Queued reply from Sub");
			await until(() => f!.session.agent.peekQueuedMessages().some((queued) => queued.role === "custom"
				&& queued.customType === MESSAGE_TYPE && (queued.details as { messageId?: string } | undefined)?.messageId === message.id));
			const file = path.join(f.channel.channelDir, "to-main", `${message.id}.json`);
			assert.ok(fs.existsSync(file));
			assert.equal(f.inboxEntries().length, 0, "Queued messages are not recorded before the native queue consumes them");
			assert.deepEqual(f.session.getFollowUpMessages(), [], "Custom follow-ups are not in Pi's user-input queue display");
			f.rescan(); f.rescan();
			assert.equal(f.requests.length, 1);
			if (mode === "reload") {
				await f.session.reload();
				f.rescan();
				f.finish();
				await initial;
			} else {
				f.session.clearQueue();
				await f.session.abort();
				await initial;
				f.rescan();
				assert.equal(f.requests.length, 1, "Abort must not immediately restart work or duplicate retained queues");
				await f.session.prompt("Continue manually");
			}
			await until(() => !fs.existsSync(file));
			await f.session.waitForIdle();
			assert.equal(f.inboxEntries().length, 1);
			assert.equal(f.requests.length, mode === "reload" ? 2 : 3);
			for (const request of f.requests) assert.match(getCurrentSystemMessage(request.messages)?.sections?.facets_fixture ?? "", /Fixture role instructions/);
			assert.deepEqual(f.errors, []);
		} finally {
			await f?.session.abort();
			await initial;
			f?.stop();
			f?.session.dispose();
			if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
			else process.env.XDG_RUNTIME_DIR = previous;
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}
