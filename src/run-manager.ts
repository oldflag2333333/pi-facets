import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AdapterRegistry } from "./adapters/index.js";
import {
	createChannel,
	MESSAGE_TYPE,
	listTalkToParent,
	readChildClosed,
	readManifest,
	removeChannel,
	removeTalk,
	talkToChild,
	writeClose,
} from "./channel.js";
import type { ResolvedProfile } from "./profiles/types.js";
import type { DelegateManifest, RunSnapshot } from "./types.js";

const RUN_ENTRY = "facets-run";
const NOTICE_TYPE = "facets-notice";
const POLL_MS = 400;

function parseSnapshot(value: unknown): RunSnapshot | undefined {
	if (!value || typeof value !== "object") return;
	const item = value as Partial<RunSnapshot>;
	if (item.version !== 1 || typeof item.runId !== "string" || typeof item.parentSessionId !== "string"
		|| typeof item.title !== "string" || typeof item.cwd !== "string"
		|| typeof item.profileName !== "string" || typeof item.channelDir !== "string"
		|| typeof item.createdAt !== "number" || typeof item.updatedAt !== "number") return;
	if (item.surface && item.surface.adapter !== "herdr") return;
	return {
		version: 1,
		runId: item.runId,
		parentSessionId: item.parentSessionId,
		title: item.title,
		cwd: item.cwd,
		profileName: item.profileName,
		sessionPersistence: item.sessionPersistence === "persistent" ? "persistent" : "ephemeral",
		channelDir: item.channelDir,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		...(item.surface ? { surface: item.surface } : {}),
	};
}

export class ParentRunManager {
	readonly runs = new Map<string, RunSnapshot>();
	private readonly adapters: AdapterRegistry;
	private readonly seenMessages = new Set<string>();
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

	shutdown(): void {
		if (this.poller) clearInterval(this.poller);
		this.poller = undefined;
		this.ctx = undefined;
	}

	private restore(ctx: ExtensionContext): void {
		const latest = new Map<string, RunSnapshot>();
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== RUN_ENTRY) continue;
			const snapshot = parseSnapshot(entry.data);
			if (snapshot) latest.set(snapshot.runId, snapshot);
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

	private findRun(runId: string): RunSnapshot {
		const run = this.runs.get(runId) ?? [...this.runs.values()].find((candidate) => candidate.runId.startsWith(runId));
		if (!run) throw new Error(`Unknown child '${runId}'.`);
		return run;
	}

	async create(input: {
		title: string;
		task: string;
		cwd: string;
		profile: ResolvedProfile;
	}, signal?: AbortSignal): Promise<RunSnapshot> {
		if (!this.ctx) throw new Error("Facets is not attached to an active parent session.");
		const runId = randomUUID();
		const parentSessionId = this.ctx.sessionManager.getSessionId();
		const projectTrusted = this.ctx.isProjectTrusted();
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
			sessionPersistence: input.profile.sessionPersistence ?? "ephemeral",
			channelDir: channel.channelDir,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		this.save(run);
		try {
			const adapter = await this.adapters.resolve();
			const entryPath = fileURLToPath(new URL("./index.ts", import.meta.url));
			run.surface = await adapter.launch({
				runId,
				parentSessionId,
				title: input.title,
				task: input.task,
				cwd: input.cwd,
				projectTrusted,
				profile: input.profile,
				channelDir: channel.channelDir,
				token: channel.token,
				entryPath,
			}, signal);
			this.save(run);
			this.recordNotice(`Child created: ${run.title}`);
			return run;
		} catch (error) {
			this.runs.delete(run.runId);
			removeChannel(run.channelDir);
			throw error;
		}
	}

	talk(runId: string, message: string): { run: RunSnapshot; messageId: string } {
		const run = this.findRun(runId);
		const manifest = readManifest(run.channelDir);
		const sent = talkToChild(run.channelDir, manifest, message);
		return { run, messageId: sent.id };
	}

	async close(runId: string, reason: string): Promise<RunSnapshot> {
		const run = this.findRun(runId);
		try {
			const manifest = readManifest(run.channelDir);
			writeClose(run.channelDir, manifest, reason);
		} catch {}
		await this.adapters.close(run.surface);
		this.runs.delete(run.runId);
		removeChannel(run.channelDir);
		this.recordNotice(`Child closed: ${run.title}`);
		return run;
	}

	private poll(): void {
		for (const run of this.runs.values()) {
			let manifest: DelegateManifest;
			try { manifest = readManifest(run.channelDir); } catch { continue; }
			if (readChildClosed(run.channelDir, manifest)) {
				this.runs.delete(run.runId);
				removeChannel(run.channelDir);
				this.recordNotice(`Child closed: ${run.title}`);
				continue;
			}
			if (!this.ctx?.isIdle()) continue;
			for (const message of listTalkToParent(run.channelDir, manifest)) {
				const key = `${run.runId}:${message.id}`;
				if (this.seenMessages.has(key)) continue;
				this.seenMessages.add(key);
				this.notify(run, message.message);
				removeTalk(run.channelDir, "to-parent", message.id);
				return;
			}
		}
	}

	private recordNotice(content: string): void {
		this.pi.appendEntry(NOTICE_TYPE, content);
	}

	private notify(run: RunSnapshot, message: string): void {
		this.pi.sendMessage({
			customType: MESSAGE_TYPE,
			content: `[Facets child message]\nChild '${run.title}' (${run.runId}) says:\n${message}\n\nUse talk with runId '${run.runId}' to respond, or close_child when the delivery is accepted and no more work is needed.`,
			display: true,
			details: { title: run.title, message },
		}, { deliverAs: "followUp", triggerTurn: true });
	}
}

export { NOTICE_TYPE, RUN_ENTRY };
