import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";

const SUB_SESSION_PREFIX = "[sub] ";

export interface ResumableSubSession {
	sessionId: string;
	sessionFile: string;
	title: string;
	cwd: string;
	modifiedAt: number;
}

function subSession(info: SessionInfo): ResumableSubSession | undefined {
	if (!info.name?.startsWith(SUB_SESSION_PREFIX) || !info.cwd) return;
	const title = info.name.slice(SUB_SESSION_PREFIX.length).trim();
	if (!title) return;
	return {
		sessionId: info.id,
		sessionFile: info.path,
		title,
		cwd: info.cwd,
		modifiedAt: info.modified.getTime(),
	};
}

export function selectResumableSubSessions(infos: SessionInfo[], activeSessionIds = new Set<string>()): ResumableSubSession[] {
	return infos
		.map(subSession)
		.filter((session): session is ResumableSubSession => session !== undefined)
		.filter((session) => !activeSessionIds.has(session.sessionId))
		.sort((left, right) => right.modifiedAt - left.modifiedAt || left.sessionId.localeCompare(right.sessionId));
}

export async function listResumableSubSessions(activeSessionIds = new Set<string>()): Promise<ResumableSubSession[]> {
	return selectResumableSubSessions(await SessionManager.listAll(), activeSessionIds);
}

export async function resolveResumableSubSession(sessionId: string): Promise<ResumableSubSession> {
	const sessions = (await SessionManager.listAll()).map(subSession).filter((session): session is ResumableSubSession => Boolean(session));
	const exact = sessions.find((session) => session.sessionId === sessionId);
	if (exact) return exact;
	const matches = sessions.filter((session) => session.sessionId.startsWith(sessionId));
	if (matches.length === 0) throw new Error(`No persistent Sub session matches '${sessionId}'.`);
	if (matches.length > 1) throw new Error(`Persistent Sub session id '${sessionId}' is ambiguous.`);
	return matches[0]!;
}
