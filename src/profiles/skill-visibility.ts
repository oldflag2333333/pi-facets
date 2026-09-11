import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { runtimeRoot } from "../channel.js";

function exposeToModel(content: string): string | undefined {
	const lines = content.split(/\r?\n/);
	if ((lines[0] ?? "").replace(/^\uFEFF/, "").trim() !== "---") return undefined;
	let changed = false;
	for (let index = 1; index < lines.length; index += 1) {
		if (lines[index]?.trim() === "---" || lines[index]?.trim() === "...") break;
		const match = lines[index]?.match(/^(\s*disable-model-invocation\s*:\s*)true(\s*(?:#.*)?)$/i);
		if (!match) continue;
		lines[index] = `${match[1]}false${match[2]}`;
		changed = true;
	}
	return changed ? lines.join("\n") : undefined;
}

function linkSkillAssets(sourcePath: string, mirrorDir: string): void {
	const sourceDir = path.dirname(sourcePath);
	for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
		if (entry.name === path.basename(sourcePath) || entry.name === "SKILL.md") continue;
		const target = path.join(mirrorDir, entry.name);
		if (fs.existsSync(target)) continue;
		const source = path.join(sourceDir, entry.name);
		try {
			fs.symlinkSync(source, target, entry.isDirectory() ? "dir" : "file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

/**
 * A skill explicitly selected by a Facets profile is model-visible even when
 * its source frontmatter opts out of ambient model invocation. The source is
 * never modified; a private runtime mirror preserves relative assets.
 */
export function materializeProfileSkill(sourcePath: string): string {
	const content = fs.readFileSync(sourcePath, "utf8");
	const visibleContent = exposeToModel(content);
	if (visibleContent === undefined) return sourcePath;

	const key = createHash("sha256")
		.update(path.resolve(sourcePath))
		.update("\0")
		.update(visibleContent)
		.digest("hex");
	const mirrorDir = path.join(runtimeRoot(), "profile-skills", key);
	fs.mkdirSync(mirrorDir, { recursive: true, mode: 0o700 });
	linkSkillAssets(sourcePath, mirrorDir);

	const mirrorPath = path.join(mirrorDir, "SKILL.md");
	if (!fs.existsSync(mirrorPath)) {
		const temporary = `${mirrorPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
		fs.writeFileSync(temporary, visibleContent, { encoding: "utf8", mode: 0o600 });
		try {
			fs.renameSync(temporary, mirrorPath);
		} finally {
			try { fs.rmSync(temporary, { force: true }); } catch {}
		}
	}
	return mirrorPath;
}
