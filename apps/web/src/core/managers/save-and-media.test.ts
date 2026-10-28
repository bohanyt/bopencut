import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";

// Stub the GPU modules (unused here) before EditorCore pulls them in; see scene-history.test.ts.
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { EditorCore } = await import("@/core");
const { agentReadiness } = await import("@/agent/bridge");
const { StorageService, storageService } = await import("@/services/storage/service");

const asset = (id: string) => ({ id, name: id, type: "image", file: new File([id], `${id}.png`) }) as MediaAsset;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const project = (id: string, updatedAt: Date) => ({
	metadata: { id, name: id, thumbnail: "t", createdAt: new Date(0), updatedAt }, currentSceneId: "main",
	scenes: [{ id: "main", name: "Main", isMain: true, tracks: { main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements: [] }, overlay: [], audio: [] }, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0) }],
	settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
}) as unknown as TProject;

const stubbed = new Set<string>();
function stub(methods: Record<string, unknown>) {
	Object.assign(storageService, methods);
	for (const key of Object.keys(methods)) stubbed.add(key);
}
afterEach(() => {
	for (const key of stubbed) delete (storageService as any)[key];
	stubbed.clear();
	EditorCore.reset();
});

/** Loads `stored` through the real ProjectManager.loadProject (storage stubbed). */
async function load(stored: TProject, media: { assets?: MediaAsset[]; failed?: string[] } = {}) {
	const editor = EditorCore.getInstance();
	stub({
		ensureMigrations: async () => {},
		loadProject: async () => ({ project: structuredClone(stored) }),
		loadAllMediaAssets: async ({ onFailed }: { onFailed?: (f: { id: string; name: string; error: string }) => void }) => {
			for (const id of media.failed ?? []) onFailed?.({ id, name: id, error: "Media cannot be read" });
			return media.assets ?? [];
		},
		saveProject: async () => {},
	});
	await editor.project.loadProject({ id: stored.metadata.id });
	return editor;
}

describe("missing media", () => {
	test("a stored file that cannot be read is reported, not silently dropped, and can be retried", async () => {
		const editor = await load(project("p", new Date(0)), { assets: [asset("a")], failed: ["b"] });
		expect(editor.media.getMissingMedia()).toEqual([{ id: "b", name: "b", error: "Media cannot be read" }]);
		// Policy: loading finished, so ready; the agent sees what is missing and decides.
		expect(agentReadiness()).toMatchObject({ ready: true, mediaLoaded: true, missingMedia: [{ id: "b" }] });
		stub({ loadMediaAsset: async ({ id }: { id: string }) => asset(id) });
		expect(await editor.media.retryMissingMedia({ projectId: "p" })).toEqual([]);
		expect(editor.media.getAssets().map((m) => m.id).sort()).toEqual(["a", "b"]);
		expect(agentReadiness().missingMedia).toEqual([]);
	});

	test("the storage loader reports every unreadable file", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string) => (/\/media$/.test(String(url))
			? new Response(JSON.stringify([{ id: "a", name: "A", type: "image" }, { id: "b", name: "B", type: "image" }]))
			: String(url).endsWith("/b") ? new Response(null, { status: 404 }) : new Response(new Blob(["x"])))) as typeof fetch;
		try {
			const failed: string[] = [];
			const assets = await new StorageService().loadAllMediaAssets({ projectId: "p", onFailed: ({ id }) => failed.push(id) });
			expect(assets.map((a) => a.id)).toEqual(["a"]);
			expect(failed).toEqual(["b"]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

describe("failed saves", () => {
	const dirty = async (failures: number) => {
		const editor = await load(project("p", new Date(0)));
		(editor.save as any).retryDelaysMs = [5, 10];
		let calls = 0;
		editor.project.persistCurrentProject = async () => {
			calls++;
			const error = calls <= failures ? "EPERM: operation not permitted" : null;
			editor.save.recordPersisted({ projectId: "p", error });
			return error;
		};
		editor.save.markDirty();
		await editor.save.flush();
		return { editor, calls: () => calls };
	};

	test("are retried with backoff without any further edit", async () => {
		const { editor, calls } = await dirty(2);
		expect(agentReadiness()).toMatchObject({ ready: false, saveError: "EPERM: operation not permitted" });
		await wait(80);
		expect(calls()).toBe(3);
		expect(editor.save.getIsDirty()).toBe(false);
		expect(agentReadiness()).toMatchObject({ ready: true, saveError: null });
	});

	test("stop retrying after the backoff, then a manual retry saves", async () => {
		const { editor, calls } = await dirty(3);
		await wait(80);
		expect(calls()).toBe(3);
		await wait(40);
		expect(calls()).toBe(3);
		expect(agentReadiness().ready).toBe(false);
		await editor.save.retry();
		expect(calls()).toBe(4);
		expect(agentReadiness()).toMatchObject({ ready: true, saveError: null });
	});

	test("settle gives up at its deadline even while a save hangs", async () => {
		const editor = await load(project("p", new Date(0)));
		editor.project.persistCurrentProject = () => new Promise(() => {});
		editor.save.markDirty();
		const started = Date.now();
		expect(await editor.save.settle({ timeoutMs: 40 })).toBe(false);
		expect(Date.now() - started).toBeLessThan(500);
	});
});

describe("savedAt", () => {
	test("is per project: from the stored project on load, then only from successful writes", async () => {
		const storedA = new Date("2026-01-01T00:00:00Z");
		const editor = await load(project("a", storedA));
		expect(agentReadiness().savedAt).toBe(storedA.toISOString());
		// Metadata changes that are not written do not move it.
		await editor.project.updateThumbnail({ thumbnail: "new" });
		expect(agentReadiness().savedAt).toBe(storedA.toISOString());
		const before = Date.now();
		expect(await editor.project.saveCurrentProject()).toBe(true);
		const savedA = agentReadiness().savedAt!;
		expect(Date.parse(savedA)).toBeGreaterThanOrEqual(before);

		const storedB = new Date("2025-06-01T00:00:00Z");
		await load(project("b", storedB));
		expect(agentReadiness().savedAt).toBe(storedB.toISOString());
		stub({ saveProject: async () => { throw new Error("disk full"); } });
		expect(await editor.project.saveCurrentProject()).toBe(false);
		expect(agentReadiness()).toMatchObject({ savedAt: storedB.toISOString(), saveError: "disk full" });
		expect(editor.save.getLastSavedAt("a")?.toISOString()).toBe(savedA);
	});
});

describe("saving does not re-render the editor", () => {
	test("persisting keeps the active project object and does not notify project subscribers", async () => {
		const editor = await load(project("p", new Date(0)));
		const active = editor.project.getActive();
		let notified = 0;
		const unsubscribe = editor.project.subscribe(() => notified++);
		expect(await editor.project.saveCurrentProject()).toBe(true);
		unsubscribe();
		expect(editor.project.getActive()).toBe(active);
		expect(notified).toBe(0);
	});
});

describe("media manifest cache", () => {
	test("keeps the two most recent projects and forgets closed ones", async () => {
		let lists = 0;
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string) => {
			if (/\/media$/.test(String(url))) {
				lists++;
				return new Response(JSON.stringify([{ id: "m", name: "m", type: "image" }]));
			}
			return new Response(new Blob(["x"]));
		}) as typeof fetch;
		try {
			const service = new StorageService();
			for (const id of ["p1", "p2", "p3"]) await service.loadAllMediaAssets({ projectId: id });
			expect(lists).toBe(3);
			await service.loadMediaAsset({ projectId: "p3", id: "m" });
			await service.loadMediaAsset({ projectId: "p2", id: "m" });
			expect(lists).toBe(3);
			await service.loadMediaAsset({ projectId: "p1", id: "m" });
			expect(lists).toBe(4);
			service.forgetMediaManifest({ projectId: "p1" });
			await service.loadMediaAsset({ projectId: "p1", id: "m" });
			expect(lists).toBe(5);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
