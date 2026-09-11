import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HerdrTabAdapter } from "./herdr.js";
import type { SurfaceHandle } from "../types.js";

export class AdapterRegistry {
	private readonly herdr: HerdrTabAdapter;

	constructor(pi: ExtensionAPI) {
		this.herdr = new HerdrTabAdapter(pi);
	}

	async resolve(): Promise<HerdrTabAdapter> {
		if (!(await this.herdr.available())) {
			throw new Error("Facets requires Herdr, but the Herdr adapter is unavailable.");
		}
		return this.herdr;
	}

	async close(handle: SurfaceHandle | undefined): Promise<void> {
		if (!handle) return;
		await this.herdr.close(handle);
	}
}
