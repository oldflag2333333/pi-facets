import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AdapterRegistry } from "./adapters/index.js";
import {
	createChannel,
	listQuestions,
	readManifest,
	readResult,
	removeChannel,
	writeCancel,
	writeReply,
} from "./channel.js";
import type {
	DelegateAdapterId,
	DelegateManifest,
	DelegateResult,
	RunSnapshot,
	SupervisorQuestion,
} from "./types.js";
import type { ResolvedProfile } from "./profiles/types.js";

const RUN_ENTRY = "facets-run";
const NOTICE_TYPE = "facets-notice";
const POLL_MS = 400;

interface PendingQuestion {
	run: RunSnapshot;
	manifest: DelegateManifest;
	question: SupervisorQuestion;
}

interface EphemeralPayload {
	id: string;
	kind: "question" | "result";
	text: string;
	runId: string;
}

function validSnapshot(value: unknown): value is RunSnapshot {
	if (!value || typeof value !== "object") return false;
	const item = value as Partial<RunSnapshot>;
	return item.version === 1 && typeof item.runId === "string" && typeof item.parentSessionId === "string"
		&& typeof item.title === "string" && typeof item.cwd === "string"
		&& typeof item.profileName === "string" && typeof item.channelDir === "string"
		&& typeof item.state === "string" && typeof item.createdAt === "number" && typeof item.updatedAt === "number"
		&& typeof item.deadlineAt === "number" && typeof item.closeOnTerminal === "boolean";
}

function terminal(state: RunSnapshot["state"]): boolean {
	return state === "completed" || state === "failed" || state === "cancelled";
}

function shortRunId(runId: string): string {
	return runId.slice(0, 8);
}

export class ParentRunManager {
	readonly runs = new Map<string, RunSnapshot>();
	readonly pendingQuestions = new Map<string, PendingQuestion>();
	private readonly adapters: AdapterRegistry;
	private readonly seenQuestions = new Set<string>();
	private readonly seenResults = new Set<string>();
	private readonly payloads = new Map<string, EphemeralPayload>();
	private poller?: ReturnType<typeof setInterval>;
	private ctx?: ExtensionContext;

	constructor(private readonly pi: ExtensionAPI) {
		this.adapters = new AdapterRegistry(pi);
	}

	start(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.restore(ctx);
		this.poll();
		if (!this.poller) {
			this.poller = setInterval(() => this.poll(), POLL_MS);
			this.poller.unref?.();
		}
	}

	stop(): void {
		if (this.poller) clearInterval(this.poller);
		this.poller = undefined;
		this.ctx = undefined;
	}

	async shutdown(closeChildren: boolean): Promise<void> {
		this.stop();
		if (!closeChildren) return;
		await Promise.all([...this.runs.values()].filter((run) => !terminal(run.state)).map(async (run) => {
			try {
				const manifest = readManifest(run.channelDir);
				writeCancel(run.channelDir, manifest, "Parent Pi session shut down.");
			} catch {}
			await this.adapters.close(run.surface);
		}));
	}

	private restore(ctx: ExtensionContext): void {
		const latest = new Map<string, RunSnapshot>();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== RUN_ENTRY || !validSnapshot(entry.data)) continue;
			latest.set(entry.data.runId, entry.data);
		}
		for (const run of latest.values()) {
			if (fs.existsSync(run.channelDir)) this.runs.set(run.runId, run);
		}
	}

	private save(run: RunSnapshot): void {
		run.updatedAt = Date.now();
		this.runs.set(run.runId, run);
		this.pi.appendEntry(RUN_ENTRY, { ...run });
	}

	async delegate(input: {
		title: string;
		task: string;
		cwd: string;
		profile: ResolvedProfile;
		adapter: DelegateAdapterId;
		closeOnTerminal: boolean;
		timeoutMinutes: number;
	}, signal?: AbortSignal): Promise<RunSnapshot> {
		if (!this.ctx) throw new Error("Facets is not attached to an active parent session.");
		const runId = randomUUID();
		const parentSessionId = this.ctx.sessionManager.getSessionId();
		const channel = createChannel({
			runId,
			parentSessionId,
			title: input.title,
			task: input.task,
			cwd: input.cwd,
			profile: input.profile,
		});
		const run: RunSnapshot = {
			version: 1,
			runId,
			parentSessionId,
			title: input.title,
			cwd: input.cwd,
			profileName: input.profile.name,
			channelDir: channel.channelDir,
			state: "starting",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			deadlineAt: Date.now() + input.timeoutMinutes * 60_000,
			closeOnTerminal: input.closeOnTerminal,
		};
		this.save(run);
		try {
			const adapter = await this.adapters.resolve(input.adapter);
			const entryPath = fileURLToPath(new URL("./index.ts", import.meta.url));
			run.surface = await adapter.launch({
				runId,
				parentSessionId,
				title: input.title,
				task: input.task,
				cwd: input.cwd,
				profile: input.profile,
				channelDir: channel.channelDir,
				token: channel.token,
				entryPath,
			}, signal);
			run.state = "running";
			this.save(run);
			return run;
		} catch (error) {
			run.state = "failed";
			run.error = error instanceof Error ? error.message : String(error);
			this.save(run);
			await this.adapters.close(run.surface);
			throw error;
		}
	}

	reply(requestId: string, answer: string): PendingQuestion {
		const pending = this.pendingQuestions.get(requestId);
		if (!pending) throw new Error(`No pending child question '${requestId}'.`);
		writeReply(pending.run.channelDir, pending.manifest, requestId, answer);
		this.pendingQuestions.delete(requestId);
		this.payloads.delete(`question:${requestId}`);
		pending.run.state = "running";
		this.save(pending.run);
		return pending;
	}

	async cancel(runId: string, reason: string): Promise<RunSnapshot> {
		const run = this.runs.get(runId) ?? [...this.runs.values()].find((candidate) => candidate.runId.startsWith(runId));
		if (!run) throw new Error(`Unknown delegated run '${runId}'.`);
		if (terminal(run.state)) return run;
		const manifest = readManifest(run.channelDir);
		writeCancel(run.channelDir, manifest, reason);
		run.state = "cancelled";
		run.error = reason;
		this.save(run);
		await this.adapters.close(run.surface);
		this.notify(run, "cancelled", `Subagent task cancelled: ${run.title}`);
		return run;
	}

	contextMessages(): AgentMessage[] {
		return [...this.payloads.values()].map((payload) => ({
			role: "user" as const,
			content: [{ type: "text" as const, text: payload.text }],
			timestamp: Date.now(),
		}));
	}

	settled(): void {
		for (const [id, payload] of this.payloads) {
			if (payload.kind !== "result") continue;
			this.payloads.delete(id);
			const run = this.runs.get(payload.runId);
			if (run && terminal(run.state)) removeChannel(run.channelDir);
		}
	}

	private poll(): void {
		const now = Date.now();
		for (const run of this.runs.values()) {
			let manifest: DelegateManifest;
			try { manifest = readManifest(run.channelDir); } catch { continue; }
			if (!terminal(run.state) && now > run.deadlineAt) {
				writeCancel(run.channelDir, manifest, "Delegated task timed out.");
				run.state = "failed";
				run.error = "Delegated task timed out.";
				this.save(run);
				const failure: DelegateResult = {
					version: 1, type: "result", runId: run.runId, token: manifest.token,
					createdAt: now, status: "failed", summary: "The delegated task timed out.", error: run.error,
				};
				this.handleResult(run, failure);
				continue;
			}
			for (const question of listQuestions(run.channelDir, manifest)) {
				if (this.seenQuestions.has(question.requestId)) continue;
				this.seenQuestions.add(question.requestId);
				this.pendingQuestions.set(question.requestId, { run, manifest, question });
				run.state = "waiting_parent";
				this.save(run);
				const choices = question.choices?.length ? `\nChoices: ${question.choices.map((choice, index) => `${index + 1}. ${choice}`).join(" | ")}` : "";
				const recommendation = question.recommendation ? `\nChild recommendation: ${question.recommendation}` : "";
				this.payloads.set(`question:${question.requestId}`, {
					id: question.requestId,
					kind: "question",
					runId: run.runId,
					text: `[Facets supervisor request]\nChild '${run.title}' asks:\n${question.question}${choices}${recommendation}\nAnswer it by calling reply_child with requestId '${question.requestId}'. Do not claim the delegated task is complete.`,
				});
				this.notify(run, "question", `Subagent needs an answer: ${run.title}`);
			}
			const result = readResult(run.channelDir, manifest);
			if (result) this.handleResult(run, result);
		}
	}

	private handleResult(run: RunSnapshot, result: DelegateResult): void {
		if (this.seenResults.has(run.runId)) return;
		this.seenResults.add(run.runId);
		run.state = result.status === "completed" ? "completed" : "failed";
		run.error = result.error;
		this.save(run);
		this.payloads.set(`result:${run.runId}`, {
			id: run.runId,
			kind: "result",
			runId: run.runId,
			text: `[Facets completed result]\nA delegated child named '${run.title}' has finished. Use this result to continue the user's task. This is the bounded final handoff, not the child's transcript.\n${JSON.stringify({ status: result.status, summary: result.summary, changedFiles: result.changedFiles, artifacts: result.artifacts, nextSteps: result.nextSteps, error: result.error }, null, 2)}`,
		});
		this.notify(run, result.status, result.status === "completed" ? `Subagent completed: ${run.title}` : `Subagent failed: ${run.title}`);
		if (run.closeOnTerminal) setTimeout(() => void this.adapters.close(run.surface), 500).unref?.();
	}

	private notify(run: RunSnapshot, event: string, content: string): void {
		this.pi.sendMessage({
			customType: NOTICE_TYPE,
			content,
			display: true,
			details: { runId: run.runId, title: run.title, state: run.state, event },
		}, { deliverAs: "followUp", triggerTurn: true });
	}
}

export { NOTICE_TYPE, RUN_ENTRY };
