import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { HeadlessAdapter } from "./headless.js";
import { HerdrTabAdapter } from "./herdr.js";
import type { ChildSurfaceAdapter, DelegateAdapterId, SurfaceHandle } from "../types.js";

export class AdapterRegistry {
	private readonly adapters: Map<string, ChildSurfaceAdapter>;

	constructor(pi: ExtensionAPI) {
		this.adapters = new Map<string, ChildSurfaceAdapter>([
			["herdr", new HerdrTabAdapter(pi)],
			["headless", new HeadlessAdapter()],
		]);
	}

	async resolve(requested: DelegateAdapterId): Promise<ChildSurfaceAdapter> {
		if (requested !== "auto") {
			const adapter = this.adapters.get(requested);
			if (!adapter || !(await adapter.available())) throw new Error(`Requested child adapter '${requested}' is unavailable.`);
			return adapter;
		}
		const herdr = this.adapters.get("herdr")!;
		return await herdr.available() ? herdr : this.adapters.get("headless")!;
	}

	async close(handle: SurfaceHandle | undefined): Promise<void> {
		if (!handle) return;
		await this.adapters.get(handle.adapter)?.close(handle);
	}
}
