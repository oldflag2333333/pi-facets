import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { childCapabilityArgs } from "../profiles/launch-args.js";
import type { ChildLaunchSpec, ChildSurfaceAdapter, SurfaceHandle } from "../types.js";

function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function launchArgs(spec: ChildLaunchSpec): string[] {
	return [
		"--mode", "json",
		"--no-session",
		"--no-extensions",
		"-e", spec.entryPath,
		"--no-approve",
		"--name", `[sub] ${spec.title.slice(0, 48)}`,
		...childCapabilityArgs(spec.profile, spec.entryPath),
		"--",
		spec.task,
	];
}

export class HeadlessAdapter implements ChildSurfaceAdapter {
	readonly id = "headless" as const;
	async available(): Promise<boolean> { return true; }

	async launch(spec: ChildLaunchSpec): Promise<SurfaceHandle> {
		const invocation = piInvocation(launchArgs(spec));
		const child = spawn(invocation.command, invocation.args, {
			cwd: spec.cwd,
			shell: false,
			windowsHide: true,
			env: {
				...process.env,
				PI_FACETS_ROLE: "child",
				PI_FACETS_CHANNEL: spec.channelDir,
				PI_FACETS_TOKEN: spec.token,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		child.stdout?.resume();
		child.stderr?.resume();
		return { adapter: "headless", pid: child.pid };
	}

	async close(handle: SurfaceHandle): Promise<void> {
		if (!handle.pid) return;
		try { process.kill(handle.pid, "SIGTERM"); } catch {}
	}
}
