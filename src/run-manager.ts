import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AdapterRegistry } from "./adapters/index.js";
import { ChannelMonitor } from "./channel-monitor.js";
import { bindInboxEvents } from "./inbox-state.js";
import { HerdrLaunchCleanupError } from "./adapters/herdr.js";
import {
	createChannel,
	readActiveTurn,
	listTalkToMain,
	readSubClosed,
	readSubSessionInfo,
	readManifest,
	removeChannel,
	talkToSub,
	writeClose,
	writeSubClosed,
	writeInterrupt,
} from "./channel.js";
import type { ResolvedProfile } from "./profiles/types.js";
import { listResumableSubSessions, resolveResumableSubSession } from "./sessions.js";
import { deliverTalk, ProtocolErrors } from "./talk-delivery.js";
import type { RunSnapshot, SubAgentStatus } from "./types.js";

const RUN_ENTRY = "facets-run";

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
		...(typeof item.closedAt === "number" ? { closedAt: item.closedAt } : {}),
		...(typeof item.subSessionId === "string" ? { subSessionId: item.subSessionId } : {}),
		...(typeof item.subSessionFile === "string" ? { subSessionFile: item.subSessionFile } : {}),
		...(item.surface ? { surface: item.surface } : {}),
	};
}

export class MainRunManager {
	readonly runs = new Map<string, RunSnapshot>();
	private readonly titles = new Map<string, string>();
	private readonly adapters: AdapterRegistry;
	private readonly closedRuns = new Map<string, RunSnapshot>();
	private readonly pollErrors = new ProtocolErrors();
	private readonly monitor: ChannelMonitor;
	private eventsBound = false;
	private ctx?: ExtensionContext;

	constructor(private readonly pi: ExtensionAPI) {
		this.adapters = new AdapterRegistry(pi);
		this.monitor = new ChannelMonitor(
			(ids) => this.poll(ids),
			(id, error) => {
				if (this.ctx) this.pollErrors.report(this.ctx, `watch:${id}`, new Error(`File watching unavailable; the 5-second scan remains active. ${error instanceof Error ? error.message : String(error)}`));
			},
			(id) => this.pollErrors.clear(`watch:${id}`),
		);
	}

	start(ctx: ExtensionContext): void {
		this.ctx = ctx;
		if (!this.eventsBound) {
			bindInboxEvents(this.pi, () => this.ctx, () => this.monitor.wakeAll());
			this.eventsBound = true;
		}
		this.restore(ctx);
		for (const run of [...this.runs.values(), ...this.closedRuns.values()]) this.monitor.add(run.runId, run.channelDir, "to-main");
		this.monitor.start();
		this.poll();
	}

	shutdown(): void {
		this.monitor.stop();
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
			if (fs.existsSync(run.channelDir)) {
				(run.closedAt === undefined ? this.runs : this.closedRuns).set(run.runId, run);
			}
		}
	}

	private save(run: RunSnapshot): void {
		run.updatedAt = Date.now();
		if (run.closedAt === undefined) {
			this.runs.set(run.runId, run);
			this.closedRuns.delete(run.runId);
		} else {
			this.runs.delete(run.runId);
			this.closedRuns.set(run.runId, run);
		}
		this.titles.set(run.runId, run.title);
		this.pi.appendEntry(RUN_ENTRY, { ...run });
		this.monitor.add(run.runId, run.channelDir, "to-main");
		this.monitor.wake(run.runId);
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
		const exact = this.runs.get(runId);
		if (exact) return exact;
		const matches = [...this.runs.values()].filter((candidate) => candidate.runId.startsWith(runId));
		if (matches.length > 1) throw new Error(`Ambiguous Sub prefix '${runId}'. Use a longer run ID.`);
		if (!matches[0]) throw new Error(`Unknown Sub '${runId}'.`);
		return matches[0];
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
		try {
			this.save(run);
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
			let cleanupFailure: unknown;
			if (error instanceof HerdrLaunchCleanupError) {
				run.surface = error.handle;
				cleanupFailure = error;
			} else if (run.surface) {
				try { await this.adapters.close(run.surface); } catch (cleanup) { cleanupFailure = cleanup; }
			}
			if (cleanupFailure) {
				let persistenceFailure = "";
				try { this.save(run); } catch (persist) { persistenceFailure = ` Recovery state could not be persisted: ${persist instanceof Error ? persist.message : String(persist)}.`; }
				const original = error instanceof Error ? error.message : String(error);
				const cleanup = cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure);
				const failure = error === cleanupFailure ? original : `${original} Cleanup failed: ${cleanup}`;
				throw new Error(`${failure} Sub run ${run.runId} remains open.${persistenceFailure} Use close_sub to retry.`, { cause: error });
			}
			this.retainClosed(run, "The Sub launch did not complete.");
			throw error;
		}
	}

	talk(runId: string, message: string): { run: RunSnapshot; messageId: string } {
		const run = this.findRun(runId);
		const manifest = readManifest(run.channelDir);
		const sent = talkToSub(run.channelDir, manifest, message);
		return { run, messageId: sent.id };
	}

	async subs(all = false): Promise<{
		open: Array<{ run: RunSnapshot; status: SubAgentStatus }>;
		resumable: Awaited<ReturnType<typeof listResumableSubSessions>>;
	}> {
		const runs = [...this.runs.values()];
		const activeSessionIds = new Set(runs.flatMap((run) => run.subSessionId ? [run.subSessionId] : []));
		const [open, resumable] = await Promise.all([
			Promise.all(runs.map(async (run) => ({ run, status: await this.adapters.status(run.surface) }))),
			listResumableSubSessions(activeSessionIds),
		]);
		return {
			open: all ? open : open.filter(({ run, status }) => run.sessionPersistence === "persistent" || status === "working" || status === "blocked"),
			resumable,
		};
	}

	interrupt(runId: string): RunSnapshot {
		const run = this.findRun(runId);
		const manifest = readManifest(run.channelDir);
		const turn = readActiveTurn(run.channelDir, manifest);
		if (!turn) throw new Error(`Sub '${run.title}' has no active turn to interrupt.`);
		writeInterrupt(run.channelDir, manifest, turn);
		return run;
	}

	async close(runId: string, reason: string): Promise<RunSnapshot> {
		const run = this.findRun(runId);
		try {
			const manifest = readManifest(run.channelDir);
			writeClose(run.channelDir, manifest, reason);
		} catch {}
		await this.adapters.close(run.surface);
		this.retainClosed(run, reason);
		return run;
	}

	private retainClosed(run: RunSnapshot, reason: string): void {
		run.closedAt = Date.now();
		try {
			const manifest = readManifest(run.channelDir);
			// Preserve the closure fact even if session persistence later fails.
			writeSubClosed(run.channelDir, manifest, reason);
			if (listTalkToMain(run.channelDir, manifest).length === 0) {
				this.finishClosed(run);
				return;
			}
		} catch (error) { this.reportChannelError(run, error); }
		// A closed surface with a pending or broken inbox is not an open Sub.
		this.save(run);
	}

	private reportChannelError(run: RunSnapshot, error: unknown): void {
		if (this.ctx) this.pollErrors.report(this.ctx, run.runId, error);
		else console.error(`Facets channel error (${run.runId}): ${error instanceof Error ? error.message : String(error)}`);
	}

	private finishClosed(run: RunSnapshot): void {
		removeChannel(run.channelDir);
		this.monitor.remove(run.runId);
		this.runs.delete(run.runId);
		this.closedRuns.delete(run.runId);
		this.pollErrors.clear(run.runId);
	}

	private poll(ids?: string[]): void {
		const ctx = this.ctx;
		if (!ctx) return;
		const runs = ids ? ids.flatMap((id) => {
			const run = this.runs.get(id) ?? this.closedRuns.get(id);
			return run ? [run] : [];
		}) : [...this.runs.values(), ...this.closedRuns.values()];
		for (const run of runs) {
			try {
				const manifest = readManifest(run.channelDir);
				if (manifest.runId !== run.runId || manifest.mainSessionId !== run.mainSessionId) throw new Error("Channel manifest identity mismatch.");
				const session = readSubSessionInfo(run.channelDir, manifest);
				if (session && (run.subSessionId !== session.sessionId || run.subSessionFile !== session.sessionFile)) {
					run.subSessionId = session.sessionId;
					run.subSessionFile = session.sessionFile;
					this.save(run);
				}
				if (run.closedAt === undefined && readSubClosed(run.channelDir, manifest)) {
					run.closedAt = Date.now();
					this.save(run);
				}
				const messages = listTalkToMain(run.channelDir, manifest);
				let pending = messages.length;
				for (const message of messages) {
					const content = `[Facets Sub message]\nSub '${run.title}' (${run.runId}) says:\n${message.message}\n\n${run.closedAt === undefined ? `Use talk with runId '${run.runId}' to respond, or close_sub when the delivery is accepted and no more work is needed.` : "This Sub has already closed; this is a retained final delivery."}`;
					const result = deliverTalk(this.pi, ctx, run.channelDir, manifest, "to-main", message, content);
					if (result === "acknowledged") pending--;
				}
				if (run.closedAt !== undefined && pending === 0) this.finishClosed(run);
				this.pollErrors.clear(run.runId);
			} catch (error) {
				this.pollErrors.report(ctx, run.runId, error);
			}
		}
	}
}

export { RUN_ENTRY };
