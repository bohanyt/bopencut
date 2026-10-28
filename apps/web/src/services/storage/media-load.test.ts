import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";

// Stub the GPU modules (unused here) before EditorCore pulls them in; see scene-history.test.ts.
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { EditorCore } = await import("@/core");
const { StorageService, storageService } = await import("./service");

const metadata = (n: number) => ({ id: `m${n}`, name: `m${n}`, type: "image", fileName: `m${n}.png`, fileType: "image/png", size: 1, lastModified: 0 });

/** Fake storage API: `count` media; counts list requests and concurrent file reads. */
function fakeApi(count: number, { fileDelayMs = 2, failing = new Set<string>() } = {}) {
	const stats = { lists: 0, files: 0, inFlight: 0, maxInFlight: 0 };
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string, init?: { signal?: AbortSignal }) => {
		const path = String(url);
		if (/\/media$/.test(path)) {
			stats.lists++;
			return new Response(JSON.stringify(Array.from({ length: count }, (_, n) => metadata(n))));
		}
		const id = decodeURIComponent(path.split("/").pop() ?? "");
		stats.files++;
		stats.inFlight++;
		stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
		try {
			await new Promise((resolve) => setTimeout(resolve, fileDelayMs));
			init?.signal?.throwIfAborted();
			return failing.has(id) ? new Response(null, { status: 404 }) : new Response(new Blob([id]));
		} finally {
			stats.inFlight--;
		}
	}) as unknown as typeof fetch;
	return { stats, restore: () => { globalThis.fetch = realFetch; } };
}

let restore = () => {};
afterEach(() => {
	restore();
	restore = () => {};
	for (const key of ["loadAllMediaAssets", "saveMediaAsset"]) delete (storageService as any)[key];
	EditorCore.reset();
});

describe("loading project media", () => {
	test("600 assets: one metadata request, bounded concurrency, list order kept, unreadable files skipped", async () => {
		const api = fakeApi(600, { failing: new Set(["m7"]) });
		restore = api.restore;
		const progress: number[] = [];
		const assets = await new StorageService().loadAllMediaAssets({ projectId: "p", concurrency: 6, onProgress: ({ loaded }) => progress.push(loaded) });
		// The old loader requested the whole list once per asset (601 list requests here).
		expect(api.stats.lists).toBe(1);
		expect(api.stats.files).toBe(600);
		expect(api.stats.maxInFlight).toBeLessThanOrEqual(6);
		expect(assets.length).toBe(599);
		expect(assets.slice(0, 8).map((a) => a.id)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m8"]);
		expect(progress.at(-1)).toBe(600);
	});

	test("one asset after a full load reads its metadata from the cache", async () => {
		const api = fakeApi(10);
		restore = api.restore;
		const service = new StorageService();
		await service.loadAllMediaAssets({ projectId: "p" });
		expect((await service.loadMediaAsset({ projectId: "p", id: "m3" }))?.id).toBe("m3");
		expect(api.stats.lists).toBe(1);
	});

	test("aborting stops starting new file reads", async () => {
		const api = fakeApi(200, { fileDelayMs: 5 });
		restore = api.restore;
		const controller = new AbortController();
		const load = new StorageService().loadAllMediaAssets({ projectId: "p", concurrency: 4, signal: controller.signal });
		setTimeout(() => controller.abort(), 12);
		await expect(load).rejects.toBeDefined();
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(api.stats.files).toBeLessThan(40);
	});
});

const asset = (id: string) => ({ id, name: id, type: "image", file: new File([id], `${id}.png`) }) as MediaAsset;
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => { resolve = r; });
	return { promise, resolve };
}

describe("media manager loads", () => {
	test("assets added while loading are merged, not overwritten", async () => {
		const media = EditorCore.getInstance().media;
		const stored = deferred<MediaAsset[]>();
		(storageService as any).loadAllMediaAssets = () => stored.promise;
		const load = media.loadProjectMedia({ projectId: "p" });
		expect(media.isProjectMediaLoaded({ projectId: "p" })).toBe(false);
		// e.g. an agent adding four logos during the load
		media.setAssets({ assets: [...media.getAssets(), asset("logo-1"), asset("logo-2")] });
		stored.resolve([asset("a"), asset("b"), asset("logo-1")]);
		await load;
		expect(media.getAssets().map((a) => a.id)).toEqual(["a", "b", "logo-1", "logo-2"]);
		expect(media.isProjectMediaLoaded({ projectId: "p" })).toBe(true);
	});

	test("a stale load never overwrites a newer one or a cleared project", async () => {
		const media = EditorCore.getInstance().media;
		const first = deferred<MediaAsset[]>();
		const second = deferred<MediaAsset[]>();
		const signals: AbortSignal[] = [];
		const queue = [first, second];
		(storageService as any).loadAllMediaAssets = ({ signal }: { signal: AbortSignal }) => {
			signals.push(signal);
			return queue.shift()!.promise;
		};
		const a = media.loadProjectMedia({ projectId: "p1" });
		const b = media.loadProjectMedia({ projectId: "p2" });
		expect(signals[0].aborted).toBe(true);
		second.resolve([asset("p2-media")]);
		await b;
		first.resolve([asset("p1-media")]);
		await a;
		expect(media.getAssets().map((x) => x.id)).toEqual(["p2-media"]);
		expect(media.isProjectMediaLoaded({ projectId: "p2" })).toBe(true);
		expect(media.isLoadingMedia()).toBe(false);

		const third = deferred<MediaAsset[]>();
		(storageService as any).loadAllMediaAssets = () => third.promise;
		const c = media.loadProjectMedia({ projectId: "p3" });
		media.clearAllAssets();
		third.resolve([asset("p3-media")]);
		await c;
		expect(media.getAssets()).toEqual([]);
		expect(media.isProjectMediaLoaded({ projectId: "p3" })).toBe(false);
	});
});

describe("frame rate on import", () => {
	const setup = () => {
		const editor = EditorCore.getInstance();
		editor.project.setActiveProject({ project: { metadata: { id: "p", name: "p" }, scenes: [], settings: { fps: { numerator: 30, denominator: 1 } } } as unknown as TProject });
		(storageService as any).saveMediaAsset = async () => {};
		return editor;
	};
	const footage = { name: "f", type: "video", file: new File(["x"], "f.mp4"), fps: 50 } as Omit<MediaAsset, "id">;

	test("agent imports (ratchetFps: false) keep the project frame rate", async () => {
		const editor = setup();
		await editor.media.addMediaAsset({ projectId: "p", asset: footage, ratchetFps: false });
		expect(editor.project.getActive().settings.fps).toEqual({ numerator: 30, denominator: 1 });
	});

	test("manual imports still raise it, as upstream", async () => {
		const editor = setup();
		await editor.media.addMediaAsset({ projectId: "p", asset: footage });
		expect(editor.project.getActive().settings.fps).toEqual({ numerator: 50, denominator: 1 });
	});
});
