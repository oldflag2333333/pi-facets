import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	CancelMessage,
	DelegateManifest,
	DelegateResult,
	SupervisorQuestion,
	SupervisorReply,
} from "./types.js";

const MAX_TASK_BYTES = 1024 * 1024;
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;

function safeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || "unknown";
}

export function runtimeRoot(): string {
	const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
	const owner = typeof process.getuid === "function" ? String(process.getuid()) : safeSegment(os.userInfo().username);
	return path.join(base, `pi-facets-${owner}`);
}

export function channelPath(parentSessionId: string, runId: string): string {
	return path.join(runtimeRoot(), safeSegment(parentSessionId), safeSegment(runId));
}

function assertSize(value: unknown, maxBytes: number, label: string): void {
	const size = Buffer.byteLength(JSON.stringify(value), "utf8");
	if (size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
}

export function writeAtomicJson(file: string, value: unknown, maxBytes = MAX_MESSAGE_BYTES): void {
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
	const channelDir = channelPath(input.parentSessionId, input.runId);
	fs.mkdirSync(path.join(channelDir, "requests"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(channelDir, "replies"), { recursive: true, mode: 0o700 });
	const manifest: DelegateManifest = { version: 1, ...input, token, createdAt: Date.now() };
	writeAtomicJson(path.join(channelDir, "manifest.json"), manifest, MAX_TASK_BYTES);
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
		&& (profile.instructions === undefined || typeof profile.instructions === "string"));
}

export function readManifest(channelDir: string): DelegateManifest {
	const value = record(readJson(path.join(channelDir, "manifest.json")));
	if (!value || value.version !== 1 || typeof value.runId !== "string" || typeof value.parentSessionId !== "string"
		|| typeof value.title !== "string" || typeof value.task !== "string" || typeof value.cwd !== "string"
		|| !validProfile(value.profile) || typeof value.token !== "string" || typeof value.createdAt !== "number") {
		throw new Error("Invalid Facets channel manifest.");
	}
	return value as unknown as DelegateManifest;
}

export function createQuestion(channelDir: string, manifest: DelegateManifest, input: {
	question: string;
	choices?: string[];
	recommendation?: string;
}): SupervisorQuestion {
	const requestId = randomUUID();
	const question: SupervisorQuestion = {
		version: 1,
		type: "question",
		requestId,
		runId: manifest.runId,
		token: manifest.token,
		createdAt: Date.now(),
		question: input.question,
		...(input.choices?.length ? { choices: input.choices } : {}),
		...(input.recommendation ? { recommendation: input.recommendation } : {}),
	};
	writeAtomicJson(path.join(channelDir, "requests", `${safeSegment(requestId)}.json`), question);
	return question;
}

function validQuestion(value: unknown, manifest: DelegateManifest): value is SupervisorQuestion {
	const item = record(value);
	return Boolean(item && item.version === 1 && item.type === "question"
		&& item.runId === manifest.runId && item.token === manifest.token
		&& typeof item.requestId === "string" && typeof item.createdAt === "number"
		&& typeof item.question === "string"
		&& (item.choices === undefined || (Array.isArray(item.choices) && item.choices.every((choice) => typeof choice === "string")))
		&& (item.recommendation === undefined || typeof item.recommendation === "string"));
}

export function listQuestions(channelDir: string, manifest: DelegateManifest): SupervisorQuestion[] {
	let names: string[];
	try {
		names = fs.readdirSync(path.join(channelDir, "requests"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const questions: SupervisorQuestion[] = [];
	for (const name of names.filter((name) => name.endsWith(".json")).sort()) {
		const value = readJson(path.join(channelDir, "requests", name));
		if (validQuestion(value, manifest)) questions.push(value);
	}
	return questions;
}

export function writeReply(channelDir: string, manifest: DelegateManifest, requestId: string, answer: string): SupervisorReply {
	const reply: SupervisorReply = {
		version: 1,
		type: "answer",
		requestId,
		runId: manifest.runId,
		token: manifest.token,
		createdAt: Date.now(),
		answer,
	};
	writeAtomicJson(path.join(channelDir, "replies", `${safeSegment(requestId)}.json`), reply);
	try { fs.rmSync(path.join(channelDir, "requests", `${safeSegment(requestId)}.json`), { force: true }); } catch {}
	return reply;
}

export function readReply(channelDir: string, manifest: DelegateManifest, requestId: string): SupervisorReply | undefined {
	const value = record(readJson(path.join(channelDir, "replies", `${safeSegment(requestId)}.json`)));
	if (!value || value.version !== 1 || value.type !== "answer" || value.requestId !== requestId
		|| value.runId !== manifest.runId || value.token !== manifest.token || typeof value.createdAt !== "number"
		|| typeof value.answer !== "string") return undefined;
	return value as unknown as SupervisorReply;
}

export function writeResult(channelDir: string, result: DelegateResult): void {
	writeAtomicJson(path.join(channelDir, "result.json"), result, MAX_RESULT_BYTES);
}

export function readResult(channelDir: string, manifest: DelegateManifest): DelegateResult | undefined {
	const value = record(readJson(path.join(channelDir, "result.json")));
	if (!value || value.version !== 1 || value.type !== "result" || value.runId !== manifest.runId
		|| value.token !== manifest.token || typeof value.createdAt !== "number"
		|| (value.status !== "completed" && value.status !== "failed") || typeof value.summary !== "string") return undefined;
	return value as unknown as DelegateResult;
}

export function writeCancel(channelDir: string, manifest: DelegateManifest, reason: string): void {
	const cancel: CancelMessage = {
		version: 1,
		type: "cancel",
		runId: manifest.runId,
		token: manifest.token,
		createdAt: Date.now(),
		reason,
	};
	writeAtomicJson(path.join(channelDir, "cancel.json"), cancel);
}

export function readCancel(channelDir: string, manifest: DelegateManifest): CancelMessage | undefined {
	const value = record(readJson(path.join(channelDir, "cancel.json")));
	if (!value || value.version !== 1 || value.type !== "cancel" || value.runId !== manifest.runId
		|| value.token !== manifest.token || typeof value.createdAt !== "number" || typeof value.reason !== "string") return undefined;
	return value as unknown as CancelMessage;
}

export function resultExists(channelDir: string): boolean {
	return fs.existsSync(path.join(channelDir, "result.json"));
}

export function removeChannel(channelDir: string): void {
	try { fs.rmSync(channelDir, { recursive: true, force: true }); } catch {}
}
