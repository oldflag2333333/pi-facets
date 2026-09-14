import type { ResolvedProfile, SessionPersistence } from "./profiles/types.js";

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

export interface TalkMessage {
	version: 1;
	id: string;
	runId: string;
	token: string;
	createdAt: number;
	message: string;
}

export interface CloseMessage {
	version: 1;
	runId: string;
	token: string;
	createdAt: number;
	reason: string;
}

export interface ChildClosedMessage {
	version: 1;
	runId: string;
	token: string;
	createdAt: number;
	reason: string;
}

export interface SurfaceHandle {
	adapter: "herdr";
	tabId?: string;
	paneId?: string;
}

export interface RunSnapshot {
	version: 1;
	runId: string;
	parentSessionId: string;
	title: string;
	cwd: string;
	profileName: string;
	sessionPersistence: SessionPersistence;
	channelDir: string;
	createdAt: number;
	updatedAt: number;
	surface?: SurfaceHandle;
}

export interface ChildLaunchSpec {
	runId: string;
	parentSessionId: string;
	title: string;
	task: string;
	cwd: string;
	projectTrusted: boolean;
	profile: ResolvedProfile;
	channelDir: string;
	token: string;
	entryPath: string;
}

export interface ChildSurfaceAdapter {
	readonly id: "herdr";
	available(): Promise<boolean>;
	launch(spec: ChildLaunchSpec, signal?: AbortSignal): Promise<SurfaceHandle>;
	close(handle: SurfaceHandle): Promise<void>;
}
