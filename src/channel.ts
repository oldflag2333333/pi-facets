import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	SubClosedMessage,
	SubSessionInfo,
	CloseMessage,
	DelegateManifest,
	TalkMessage,
} from "./types.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_TALK_BYTES = 1024 * 1024;
const MAX_CONTROL_BYTES = 64 * 1024;

export const MESSAGE_TYPE = "facets-message";

type TalkDirection = "to-main" | "to-sub";

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "unknown";
}

export function runtimeRoot(): string {
	const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
	const owner = typeof process.getuid === "function" ? String(process.getuid()) : safeSegment(os.userInfo().username);
	return path.join(base, `pi-facets-${owner}`);
}

export function channelPath(mainSessionId: string, runId: string): string {
	return path.join(runtimeRoot(), safeSegment(mainSessionId), safeSegment(runId));
}

function assertSize(value: unknown, maxBytes: number, label: string): void {
	const size = Buffer.byteLength(JSON.stringify(value), "utf8");
	if (size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
}

export function writeAtomicJson(file: string, value: unknown, maxBytes = MAX_CONTROL_BYTES): void {
	assertSize(value, maxBytes, path.basename(file));
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temporary, file);
}

function readJson(file: string): unknown | undefined {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function createChannel(input: Omit<DelegateManifest, "version" | "token" | "createdAt">): DelegateManifest & { channelDir: string } {
	const token = randomBytes(32).toString("hex");
	const channelDir = channelPath(input.mainSessionId, input.runId);
	fs.mkdirSync(path.join(channelDir, "to-main"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(channelDir, "to-sub"), { recursive: true, mode: 0o700 });
	const manifest: DelegateManifest = { version: 1, ...input, token, createdAt: Date.now() };
	writeAtomicJson(path.join(channelDir, "manifest.json"), manifest, MAX_MANIFEST_BYTES);
	return { ...manifest, channelDir };
}

function validProfile(value: unknown): boolean {
	const profile = record(value);
	return Boolean(profile && profile.version === 1 && typeof profile.name === "string" && profile.name.length > 0
		&& (profile.source === "global" || profile.source === "project") && typeof profile.sourcePath === "string"
		&& Array.isArray(profile.tools) && profile.tools.length > 0 && profile.tools.every((tool) => typeof tool === "string" && tool.length > 0)
		&& (profile.skills === undefined || (Array.isArray(profile.skills) && profile.skills.every((skill) => typeof skill === "string")))
		&& Array.isArray(profile.resolvedSkills) && profile.resolvedSkills.every((skill) => typeof skill === "string")
		&& Array.isArray(profile.resolvedExtensions) && profile.resolvedExtensions.every((extension) => typeof extension === "string")
		&& (profile.description === undefined || typeof profile.description === "string")
		&& (profile.model === undefined || typeof profile.model === "string")
		&& (profile.thinkingLevel === undefined || typeof profile.thinkingLevel === "string")
		&& (profile.sessionPersistence === undefined || profile.sessionPersistence === "ephemeral" || profile.sessionPersistence === "persistent")
		&& (profile.instructions === undefined || typeof profile.instructions === "string")
		&& (profile.systemPrompt === undefined || typeof profile.systemPrompt === "string"));
}

export function readManifest(channelDir: string): DelegateManifest {
	const value = record(readJson(path.join(channelDir, "manifest.json")));
	if (!value || value.version !== 1 || typeof value.runId !== "string" || typeof value.mainSessionId !== "string"
		|| typeof value.title !== "string" || typeof value.task !== "string" || typeof value.cwd !== "string"
		|| !validProfile(value.profile) || typeof value.token !== "string" || typeof value.createdAt !== "number") {
		throw new Error("Invalid Facets channel manifest.");
	}
	return value as unknown as DelegateManifest;
}

function writeTalk(channelDir: string, manifest: DelegateManifest, direction: TalkDirection, message: string): TalkMessage {
	const talk: TalkMessage = {
		version: 1,
		id: randomUUID(),
		runId: manifest.runId,
		token: manifest.token,
		createdAt: Date.now(),
		message,
	};
	writeAtomicJson(path.join(channelDir, direction, `${safeSegment(talk.id)}.json`), talk, MAX_TALK_BYTES);
	return talk;
}

export function talkToMain(channelDir: string, manifest: DelegateManifest, message: string): TalkMessage {
	return writeTalk(channelDir, manifest, "to-main", message);
}

export function talkToSub(channelDir: string, manifest: DelegateManifest, message: string): TalkMessage {
	return writeTalk(channelDir, manifest, "to-sub", message);
}

function validTalk(value: unknown, manifest: DelegateManifest): value is TalkMessage {
	const item = record(value);
	return Boolean(item && item.version === 1 && item.runId === manifest.runId && item.token === manifest.token
		&& typeof item.id === "string" && typeof item.createdAt === "number" && typeof item.message === "string");
}

function listTalk(channelDir: string, manifest: DelegateManifest, direction: TalkDirection): TalkMessage[] {
	let names: string[];
	try {
		names = fs.readdirSync(path.join(channelDir, direction));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const messages: TalkMessage[] = [];
	for (const name of names.filter((name) => name.endsWith(".json")).sort()) {
		const value = readJson(path.join(channelDir, direction, name));
		if (validTalk(value, manifest)) messages.push(value);
	}
	return messages.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export function listTalkToMain(channelDir: string, manifest: DelegateManifest): TalkMessage[] {
	return listTalk(channelDir, manifest, "to-main");
}

export function listTalkToSub(channelDir: string, manifest: DelegateManifest): TalkMessage[] {
	return listTalk(channelDir, manifest, "to-sub");
}

export function removeTalk(channelDir: string, direction: TalkDirection, id: string): void {
	try { fs.rmSync(path.join(channelDir, direction, `${safeSegment(id)}.json`), { force: true }); } catch {}
}

export function writeSubSessionInfo(channelDir: string, manifest: DelegateManifest, input: {
	sessionId: string;
	sessionFile: string;
}): SubSessionInfo {
	const info: SubSessionInfo = {
		version: 1,
		runId: manifest.runId,
		token: manifest.token,
		sessionId: input.sessionId,
		sessionFile: input.sessionFile,
		createdAt: Date.now(),
	};
	writeAtomicJson(path.join(channelDir, "session.json"), info);
	return info;
}

export function readSubSessionInfo(channelDir: string, manifest: DelegateManifest): SubSessionInfo | undefined {
	const value = record(readJson(path.join(channelDir, "session.json")));
	if (!value || value.version !== 1 || value.runId !== manifest.runId || value.token !== manifest.token
		|| typeof value.sessionId !== "string" || typeof value.sessionFile !== "string" || typeof value.createdAt !== "number") return undefined;
	return value as unknown as SubSessionInfo;
}

export function writeClose(channelDir: string, manifest: DelegateManifest, reason: string): void {
	const message: CloseMessage = {
		version: 1,
		runId: manifest.runId,
		token: manifest.token,
		createdAt: Date.now(),
		reason,
	};
	writeAtomicJson(path.join(channelDir, "close.json"), message);
}

export function readClose(channelDir: string, manifest: DelegateManifest): CloseMessage | undefined {
	const value = record(readJson(path.join(channelDir, "close.json")));
	if (!value || value.version !== 1 || value.runId !== manifest.runId || value.token !== manifest.token
		|| typeof value.createdAt !== "number" || typeof value.reason !== "string") return undefined;
	return value as unknown as CloseMessage;
}

export function writeSubClosed(channelDir: string, manifest: DelegateManifest, reason: string): void {
	const message: SubClosedMessage = {
		version: 1,
		runId: manifest.runId,
		token: manifest.token,
		createdAt: Date.now(),
		reason,
	};
	writeAtomicJson(path.join(channelDir, "closed.json"), message);
}

export function readSubClosed(channelDir: string, manifest: DelegateManifest): SubClosedMessage | undefined {
	const value = record(readJson(path.join(channelDir, "closed.json")));
	if (!value || value.version !== 1 || value.runId !== manifest.runId || value.token !== manifest.token
		|| typeof value.createdAt !== "number" || typeof value.reason !== "string") return undefined;
	return value as unknown as SubClosedMessage;
}

export function removeChannel(channelDir: string): void {
	try { fs.rmSync(channelDir, { recursive: true, force: true }); } catch {}
}
