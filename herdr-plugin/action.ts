// @ts-nocheck
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { run } from "./index.mjs";

export default async function action(pi: ExtensionAPI): Promise<void> {
	pi.registerFlag("facets-visibility-action", {
		description: "Internal Facets Herdr visibility action",
		type: "string",
	});
	const flagIndex = process.argv.indexOf("--facets-visibility-action");
	const requested = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
	await run(typeof requested === "string" && requested.length > 0 ? requested : "startup");
	process.exit(0);
}
