import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childCapabilityArgs } from "../profiles/launch-args.js";
import type { ChildLaunchSpec, ChildSurfaceAdapter, SurfaceHandle } from "../types.js";

function parseEnvelope(stdout: string): Record<string, unknown> {
	const lines = stdout.trim().split(/\r?\n/).filter(Boolean).reverse();
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			return parsed.result && typeof parsed.result === "object" ? parsed.result as Record<string, unknown> : parsed;
		} catch {}
	}
	throw new Error(`Herdr returned no JSON response: ${stdout.slice(0, 300)}`);
}

function nestedString(value: unknown, ...keys: string[]): string | undefined {
	let current: unknown = value;
	for (const key of keys) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" ? current : undefined;
}

function safeLabel(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48) || "delegated task";
}

function agentName(runId: string): string {
	return `child-${runId.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 20)}`;
}

function childArgs(spec: ChildLaunchSpec): string[] {
	const herdrIntegration = path.join(getAgentDir(), "extensions", "herdr-agent-state.ts");
	return [
		"--no-extensions",
		"-e", spec.entryPath,
		...(fs.existsSync(herdrIntegration) ? ["-e", herdrIntegration] : []),
		"--no-session",
		"--no-approve",
		"--name", `[sub] ${safeLabel(spec.title)}`,
		...childCapabilityArgs(spec.profile, spec.entryPath),
	];
}

export class HerdrTabAdapter implements ChildSurfaceAdapter {
	readonly id = "herdr" as const;
	constructor(private readonly pi: ExtensionAPI) {}

	async available(): Promise<boolean> {
		if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID) return false;
		const result = await this.pi.exec("herdr", ["status", "server"], { timeout: 3000 });
		return result.code === 0;
	}

	async launch(spec: ChildLaunchSpec, signal?: AbortSignal): Promise<SurfaceHandle> {
		const workspaceId = process.env.HERDR_WORKSPACE_ID;
		if (!workspaceId) throw new Error("HERDR_WORKSPACE_ID is unavailable; Pi is not running in a Herdr workspace.");
		const label = `↳ pi · ${safeLabel(spec.title)}`;
		const created = await this.pi.exec("herdr", [
			"tab", "create",
			"--workspace", workspaceId,
			"--cwd", spec.cwd,
			"--label", label,
			"--env", "PI_FACETS_ROLE=child",
			"--env", `PI_FACETS_CHANNEL=${spec.channelDir}`,
			"--env", `PI_FACETS_TOKEN=${spec.token}`,
			"--no-focus",
		], { timeout: 15_000, signal });
		if (created.code !== 0) throw new Error(created.stderr || "Failed to create Herdr tab.");
		const payload = parseEnvelope(created.stdout);
		const tabId = nestedString(payload, "tab", "tab_id") ?? nestedString(payload, "tab", "id");
		const paneId = nestedString(payload, "root_pane", "pane_id") ?? nestedString(payload, "pane", "pane_id");
		if (!tabId || !paneId) throw new Error("Herdr tab creation response did not contain tab and root pane IDs.");

		const name = agentName(spec.runId);
		const started = await this.pi.exec("herdr", [
			"agent", "start", name,
			"--kind", "pi",
			"--pane", paneId,
			"--timeout", "60000",
			"--",
			...childArgs(spec),
		], { timeout: 70_000, signal });
		if (started.code !== 0) {
			await this.pi.exec("herdr", ["tab", "close", tabId], { timeout: 10_000 });
			throw new Error(started.stderr || "Failed to start child Pi in Herdr tab.");
		}

		const metadata = await this.pi.exec("herdr", [
			"pane", "report-metadata", paneId,
			"--source", "facets",
			"--token", "facets_role=subagent",
			"--token", `facets_parent_session=${spec.parentSessionId}`,
			"--token", `facets_run_id=${spec.runId}`,
			"--token", `facets_profile=${spec.profile.name}`,
		], { timeout: 10_000, signal });
		if (metadata.code !== 0) {
			await this.pi.exec("herdr", ["tab", "close", tabId], { timeout: 10_000 });
			throw new Error(metadata.stderr || "Failed to mark the Herdr pane as a Facets subagent.");
		}

		const prompted = await this.pi.exec("herdr", [
			"agent", "prompt", name,
			spec.task,
		], { timeout: 20_000, signal });
		if (prompted.code !== 0) {
			await this.pi.exec("herdr", ["tab", "close", tabId], { timeout: 10_000 });
			throw new Error(prompted.stderr || "Failed to submit the delegated task to the Herdr agent.");
		}
		return { adapter: "herdr", tabId, paneId };
	}

	async close(handle: SurfaceHandle): Promise<void> {
		if (!handle.tabId) return;
		await this.pi.exec("herdr", ["tab", "close", handle.tabId], { timeout: 10_000 });
	}
}
