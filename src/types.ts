import type { ResolvedProfile } from "./profiles/types.js";

export type DelegateAdapterId = "auto" | "herdr" | "headless";
export type RunState = "starting" | "running" | "waiting_parent" | "completed" | "failed" | "cancelled";

export interface DelegateManifest {
	version: 1;
	runId: string;
	parentSessionId: string;
	title: string;
	task: string;
	cwd: string;
	profile: ResolvedProfile;
	token: string;
	createdAt: number;
}

export interface SupervisorQuestion {
	version: 1;
	type: "question";
	requestId: string;
	runId: string;
	token: string;
	createdAt: number;
	question: string;
	choices?: string[];
	recommendation?: string;
}

export interface SupervisorReply {
	version: 1;
	type: "answer";
	requestId: string;
	runId: string;
	token: string;
	createdAt: number;
	answer: string;
}

export interface DelegateResult {
	version: 1;
	type: "result";
	runId: string;
	token: string;
	createdAt: number;
	status: "completed" | "failed";
	summary: string;
	changedFiles?: string[];
	artifacts?: string[];
	nextSteps?: string[];
	error?: string;
}

export interface CancelMessage {
	version: 1;
	type: "cancel";
	runId: string;
	token: string;
	createdAt: number;
	reason: string;
}

export interface SurfaceHandle {
	adapter: "herdr" | "headless";
	tabId?: string;
	paneId?: string;
	pid?: number;
}

export interface RunSnapshot {
	version: 1;
	runId: string;
	parentSessionId: string;
	title: string;
	cwd: string;
	profileName: string;
	channelDir: string;
	state: RunState;
	createdAt: number;
	updatedAt: number;
	deadlineAt: number;
	closeOnTerminal: boolean;
	surface?: SurfaceHandle;
	error?: string;
}

export interface ChildLaunchSpec {
	runId: string;
	parentSessionId: string;
	title: string;
	task: string;
	cwd: string;
	profile: ResolvedProfile;
	channelDir: string;
	token: string;
	entryPath: string;
}

export interface ChildSurfaceAdapter {
	readonly id: "herdr" | "headless";
	available(): Promise<boolean>;
	launch(spec: ChildLaunchSpec, signal?: AbortSignal): Promise<SurfaceHandle>;
	close(handle: SurfaceHandle): Promise<void>;
}
