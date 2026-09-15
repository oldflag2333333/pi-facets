import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AdapterRegistry } from "./adapters/index.js";
import {
	createChannel,
	MESSAGE_TYPE,
	listTalkToMain,
	readSubClosed,
	readSubSessionInfo,
	readManifest,
	removeChannel,
	removeTalk,
	talkToSub,
	writeClose,
} from "./channel.js";
import type { ResolvedProfile } from "./profiles/types.js";
import { listResumableSubSessions, resolveResumableSubSession } from "./sessions.js";
import type { DelegateManifest, RunSnapshot } from "./types.js";

const RUN_ENTRY = "facets-run";
const POLL_MS = 400;

function parseSnapshot(value: unknown): RunSnapshot | undefined {
	if (!value || typeof value !== "object") return;
	const item = value as Partial<RunSnapshot>;
	if (item.version !== 1 || typeof item.runId !== "string" || typeof item.mainSessionId !== "string"
		|| typeof item.title !== "string" || typeof item.cwd !== "string"
		|| typeof item.profileName !== "string" || typeof item.channelDir !== "string"
		|| typeof item.createdAt !== "number" || typeof item.updatedAt !== "number") return;
	if (item.surface && item.surface.adapter !== "herdr") return;
	return {
		version: 1,
		runId: item.runId,
		mainSessionId: item.mainSessionId,
		title: item.title,
		cwd: item.cwd,
		profileName: item.profileName,
		sessionPersistence: item.sessionPersistence === "persistent" ? "persistent" : "ephemeral",
		channelDir: item.channelDir,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		...(typeof item.subSessionId === "string" ? { subSessionId: item.subSessionId } : {}),
		...(typeof item.subSessionFile === "string" ? { subSessionFile: item.subSessionFile } : {}),
		...(item.surface ? { surface: item.surface } : {}),
	};
}

export class MainRunManager {
	readonly runs = new Map<string, RunSnapshot>();
	private readonly titles = new Map<string, string>();
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
			this.titles.set(run.runId, run.title);
			if (fs.existsSync(run.channelDir)) this.runs.set(run.runId, run);
		}
	}

	private save(run: RunSnapshot): void {
		run.updatedAt = Date.now();
		this.runs.set(run.runId, run);
		this.titles.set(run.runId, run.title);
		this.pi.appendEntry(RUN_ENTRY, { ...run });
	}

	titleFor(runId: string): string | undefined {
		const open = this.runs.get(runId) ?? [...this.runs.values()].find((run) => run.runId.startsWith(runId));
		if (open) {
			this.titles.set(open.runId, open.title);
			return open.title;
		}
		return this.titles.get(runId) ?? [...this.titles].find(([id]) => id.startsWith(runId))?.[1];
	}

	private findRun(runId: string): RunSnapshot {
		const run = this.runs.get(runId) ?? [...this.runs.values()].find((candidate) => candidate.runId.startsWith(runId));
		if (!run) throw new Error(`Unknown Sub '${runId}'.`);
		return run;
	}

	async delegate(input: {
		title: string;
		task: string;
		cwd: string;
		profile: ResolvedProfile;
		resumeSessionId?: string;
	}, signal?: AbortSignal): Promise<RunSnapshot> {
		if (!this.ctx) throw new Error("Facets is not attached to an active Main session.");
		const resume = input.resumeSessionId ? await resolveResumableSubSession(input.resumeSessionId) : undefined;
		if (resume && input.profile.sessionPersistence !== "persistent") {
			throw new Error(`Profile '${input.profile.name}' must use sessionPersistence 'persistent' when resuming a Sub session.`);
		}
		if (resume && [...this.runs.values()].some((run) => run.subSessionId === resume.sessionId)) {
			throw new Error(`Persistent Sub session '${resume.sessionId}' is already open.`);
		}
		const runId = randomUUID();
		const mainSessionId = this.ctx.sessionManager.getSessionId();
		const projectTrusted = this.ctx.isProjectTrusted();
		const cwd = resume?.cwd ?? input.cwd;
		const channel = createChannel({
			runId,
			mainSessionId,
			title: input.title,
			task: input.task,
			cwd,
			profile: input.profile,
		});
		const run: RunSnapshot = {
			version: 1,
			runId,
			mainSessionId,
			title: input.title,
			cwd,
			profileName: input.profile.name,
			sessionPersistence: input.profile.sessionPersistence ?? "ephemeral",
			channelDir: channel.channelDir,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			...(resume ? { subSessionId: resume.sessionId, subSessionFile: resume.sessionFile } : {}),
		};
		this.save(run);
		try {
			const adapter = await this.adapters.resolve();
			const entryPath = fileURLToPath(new URL("./index.ts", import.meta.url));
			run.surface = await adapter.launch({
				runId,
				mainSessionId,
				title: input.title,
				task: input.task,
				cwd,
				projectTrusted,
				...(resume ? { resumeSessionId: resume.sessionId } : {}),
				profile: input.profile,
				channelDir: channel.channelDir,
				token: channel.token,
				entryPath,
			}, signal);
			const session = readSubSessionInfo(run.channelDir, channel);
			if (session) {
				run.subSessionId = session.sessionId;
				run.subSessionFile = session.sessionFile;
			}
			this.save(run);
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
		const sent = talkToSub(run.channelDir, manifest, message);
		return { run, messageId: sent.id };
	}

	async subs(): Promise<{
		open: RunSnapshot[];
		resumable: Awaited<ReturnType<typeof listResumableSubSessions>>;
	}> {
		const open = [...this.runs.values()];
		const activeSessionIds = new Set(open.flatMap((run) => run.subSessionId ? [run.subSessionId] : []));
		return { open, resumable: await listResumableSubSessions(activeSessionIds) };
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
		return run;
	}

	private poll(): void {
		for (const run of this.runs.values()) {
			let manifest: DelegateManifest;
			try { manifest = readManifest(run.channelDir); } catch { continue; }
			const session = readSubSessionInfo(run.channelDir, manifest);
			if (session && (run.subSessionId !== session.sessionId || run.subSessionFile !== session.sessionFile)) {
				run.subSessionId = session.sessionId;
				run.subSessionFile = session.sessionFile;
				this.save(run);
			}
			if (readSubClosed(run.channelDir, manifest)) {
				this.runs.delete(run.runId);
				removeChannel(run.channelDir);
				continue;
			}
			if (!this.ctx?.isIdle()) continue;
			for (const message of listTalkToMain(run.channelDir, manifest)) {
				const key = `${run.runId}:${message.id}`;
				if (this.seenMessages.has(key)) continue;
				this.seenMessages.add(key);
				this.notify(run, message.message);
				removeTalk(run.channelDir, "to-main", message.id);
				return;
			}
		}
	}

	private notify(run: RunSnapshot, message: string): void {
		this.pi.sendMessage({
			customType: MESSAGE_TYPE,
			content: `[Facets Sub message]\nSub '${run.title}' (${run.runId}) says:\n${message}\n\nUse talk with runId '${run.runId}' to respond, or close_sub when the delivery is accepted and no more work is needed.`,
			display: true,
			details: { title: run.title, message },
		}, { deliverAs: "followUp", triggerTurn: true });
	}
}

export { RUN_ENTRY };
