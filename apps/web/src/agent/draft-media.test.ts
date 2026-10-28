import { afterEach, describe, expect, mock, test } from "bun:test";
import type { SceneTracks, TScene, TimelineElement, VideoElement } from "@/timeline";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

// Stub the GPU modules (unused here) before EditorCore pulls them in; see scene-history.test.ts.
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
// Asset processing needs browser media APIs: an image is 400×200 whatever its bytes.
mock.module("@/media/processing", () => ({
	processMediaAssets: async ({ files }: { files: File[] }) => Array.from(files).map((file) => ({ name: file.name, type: "image", file, width: 400, height: 200 })),
}));
const { EditorCore } = await import("@/core");
const { applyDraft } = await import("./bridge");
const { storageService } = await import("@/services/storage/service");

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const el = (type: string, id: string, start: number, duration: number, extra: Record<string, unknown> = {}) =>
	({ id, type, name: id, startTime: T(start), duration: T(duration), trimStart: T(0), trimEnd: T(0), params: {}, ...extra }) as unknown as TimelineElement;
const scene = (id: string, tracks: SceneTracks): TScene => ({ id, name: id, isMain: true, tracks, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0) });
const asset = (id: string, extra: Partial<MediaAsset> = {}) => ({ id, name: id, type: "image", file: new File(["x"], `${id}.png`, { type: "image/png" }), width: 400, height: 200, ...extra }) as MediaAsset;

function setup() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	editor.save.pause();
	const scenes = [scene("main", {
		overlay: [{ id: "t-g", name: "Shapes", type: "graphic", hidden: false, elements: [el("graphic", "box", 0, 4, { agentId: "box", definitionId: "line", params: { drawProgress: 1 } })] as any }],
		main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements: [el("image", "old", 0, 2, { agentId: "old", mediaId: "m-old" })] as VideoElement[] },
		audio: [],
	})];
	editor.project.setActiveProject({
		project: { metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) }, scenes, currentSceneId: "main", settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } } } as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	editor.media.setAssets({ assets: [asset("m-old"), asset("m-new")] });
	return editor;
}
const all = (s: TScene) => [...s.tracks.overlay, s.tracks.main, ...s.tracks.audio].flatMap((track): TimelineElement[] => track.elements);
const elements = (editor: ReturnType<typeof setup>) => editor.scenes.getScenes().flatMap(all);
const draft = (ops: unknown[], extra: Record<string, unknown> = {}) => ({ schema: "opencut-agent-draft-1", rev: `r${Math.random()}`, ops, ...extra }) as Parameters<typeof applyDraft>[0];
const image = (path: string, agent_id: string) => ({ agent_id, name: agent_id, asset: { path, type: "image", name: agent_id }, start: 0, duration: 1 });
const gate = () => {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => { open = resolve; });
	return { promise, open };
};

/**
 * Fake agent file API and storage. `slow` paths wait for their gate, `missing` paths 404.
 * Storage records saved and deleted media ids; `failSave`/`failDelete` make those calls throw.
 */
function fakeBackend({ slow = new Map<string, Promise<void>>(), missing = new Set<string>(), failSave = new Set<string>(), failDelete = false } = {}) {
	const state = { saved: [] as string[], deleted: [] as string[], results: [] as any[], fileNames: new Map<string, string>() };
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string, init?: { body?: string }) => {
		const u = String(url);
		if (u.startsWith("/api/agent/file")) {
			const path = decodeURIComponent(u.split("p=")[1]);
			await slow.get(path);
			return missing.has(path) ? new Response(null, { status: 404 }) : new Response(new Blob(["png"], { type: "image/png" }));
		}
		if (u === "/api/agent/applied") state.results.push(JSON.parse(init?.body ?? "{}"));
		return new Response("{}");
	}) as typeof fetch;
	const stubs = {
		saveMediaAsset: async ({ mediaAsset }: { mediaAsset: MediaAsset }) => {
			state.saved.push(mediaAsset.id);
			state.fileNames.set(mediaAsset.id, mediaAsset.file.name);
			// e.g. the file PUT succeeded, the metadata POST hit EPERM
			if (failSave.has(mediaAsset.file.name)) throw new Error("EPERM: operation not permitted, rename");
		},
		deleteMediaAsset: async ({ id }: { id: string }) => {
			if (failDelete) throw new Error("EBUSY: resource busy");
			state.deleted.push(id);
		},
	};
	Object.assign(storageService, stubs);
	return {
		state,
		restore: () => {
			globalThis.fetch = realFetch;
			for (const key of Object.keys(stubs)) delete (storageService as any)[key];
		},
	};
}

let restore = () => {};
afterEach(() => {
	restore();
	restore = () => {};
	EditorCore.reset();
});

describe("draft imports stay private until commit", () => {
	test("a failing draft's rollback never deletes media another edit already uses", async () => {
		const editor = setup();
		const slowBad = gate();
		const backend = fakeBackend({ slow: new Map([["bad.png", slowBad.promise]]), missing: new Set(["bad.png"]) });
		restore = backend.restore;
		// Draft A imports ok.png, then waits on bad.png (which will fail).
		const a = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("ok.png", "a-ok") }, { op: "add", track: { name: "Logos" }, element: image("bad.png", "a-bad") }]));
		while (backend.state.saved.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
		const importedId = backend.state.saved[0];
		// Meanwhile someone (a human, or a direct applyDraft call) uses that media.
		const visible = editor.media.getAssets().some((m) => m.id === importedId);
		const b = applyDraft(draft([{ op: "add", track: { name: "Clips" }, element: { agent_id: "b", name: "B", mediaId: importedId, start: 3, duration: 1 } }]));
		await new Promise((resolve) => setTimeout(resolve, 5));
		slowBad.open();
		await Promise.all([a, b]);

		expect(visible).toBe(false);
		expect(backend.state.deleted).toEqual([importedId]);
		// No clip anywhere points at media that was deleted or is not in the project.
		const known = new Set(editor.media.getAssets().map((m) => m.id));
		for (const e of elements(editor) as any[]) if (e.mediaId) {
			expect(backend.state.deleted).not.toContain(e.mediaId);
			expect(known.has(e.mediaId)).toBe(true);
		}
		const [resultA, resultB] = backend.state.results;
		expect(resultA).toMatchObject({ applied: false, rolledBack: true, cleanup: { removed: [importedId], failed: [] } });
		expect(resultB.applied).toBe(false);
		expect(resultB.results[0].error).toContain(importedId);
	});

	test("drafts run one at a time, also when applyDraft is called directly", async () => {
		const editor = setup();
		const slow = gate();
		const backend = fakeBackend({ slow: new Map([["slow.png", slow.promise]]) });
		restore = backend.restore;
		const order: string[] = [];
		const a = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("slow.png", "first") }])).then(() => order.push("first"));
		const b = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("fast.png", "second") }])).then(() => order.push("second"));
		await new Promise((resolve) => setTimeout(resolve, 10));
		// The second draft has not even started importing while the first one waits.
		expect(backend.state.saved.length).toBe(0);
		slow.open();
		await Promise.all([a, b]);
		expect(order).toEqual(["first", "second"]);
		expect(elements(editor).filter((e) => e.agentId === "first" || e.agentId === "second").length).toBe(2);
	});

	test("committed imports are published; ones only used by failed ops are removed", async () => {
		const editor = setup();
		const backend = fakeBackend();
		restore = backend.restore;
		await applyDraft(draft([
			{ op: "add", track: { name: "Logos" }, element: image("used.png", "used") },
			{ op: "add", track: { name: "Logos" }, element: { ...image("unused.png", "unused"), text: undefined, effect: undefined, model3d: {} } },
		]));
		const result = backend.state.results.at(-1);
		expect(result.results.map((r: any) => r.ok)).toEqual([true, false]);
		const used = (elements(editor).find((e) => e.agentId === "used") as any).mediaId;
		expect(editor.media.getAssets().some((m) => m.id === used)).toBe(true);
		const unusedId = backend.state.saved.find((id) => id !== used)!;
		expect(backend.state.deleted).toEqual([unusedId]);
		expect(editor.media.getAssets().some((m) => m.id === unusedId)).toBe(false);
		// Published media is never deleted by a discard.
		expect(await editor.media.discardStagedMediaAssets({ ids: [used] })).toEqual({ removed: [], failed: [{ id: used, error: "published; kept" }] });
	});
});

describe("failed imports are cleaned up and reported", () => {
	test("a save that fails after writing the file (metadata EPERM) deletes the partial file", async () => {
		const editor = setup();
		const before = JSON.stringify(editor.scenes.getScenes());
		const backend = fakeBackend({ failSave: new Set(["half.png"]) });
		restore = backend.restore;
		await applyDraft(draft([{ op: "delete", match: { agentId: "old" } }, { op: "add", track: { name: "Logos" }, element: image("half.png", "half") }]));
		const result = backend.state.results.at(-1);
		expect(backend.state.saved.length).toBe(1);
		expect(backend.state.deleted).toEqual(backend.state.saved);
		expect(result).toMatchObject({ applied: false, rolledBack: true });
		expect(result.results[1].error).toContain("EPERM");
		expect(JSON.stringify(editor.scenes.getScenes())).toBe(before);
	});

	test("cleanup failures are reported instead of claiming a full rollback", async () => {
		setup();
		const backend = fakeBackend({ missing: new Set(["gone.png"]), failDelete: true });
		restore = backend.restore;
		await applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("ok.png", "ok") }, { op: "add", track: { name: "Logos" }, element: image("gone.png", "gone") }]));
		const result = backend.state.results.at(-1);
		expect(result.applied).toBe(false);
		expect(result.rolledBack).toBe(false);
		expect(result.cleanup.failed).toEqual([{ id: backend.state.saved[0], error: "EBUSY: resource busy" }]);
		expect(result.error).toContain("1 imported file could not be removed");
	});
});

describe("replace with direct media", () => {
	test("replace by mediaId uses the preloaded media", async () => {
		const editor = setup();
		const backend = fakeBackend();
		restore = backend.restore;
		await applyDraft(draft([{ op: "replace", match: { agentId: "old" }, element: { mediaId: "m-new" } }]));
		const result = backend.state.results.at(-1);
		expect(result.results[0].ok).toBe(true);
		const replaced = elements(editor).find((e) => e.agentId === "old") as any;
		expect(replaced.mediaId).toBe("m-new");
		expect(replaced.id).not.toBe("old");
	});

	test("replace by asset uses the imported media", async () => {
		const editor = setup();
		const backend = fakeBackend();
		restore = backend.restore;
		await applyDraft(draft([{ op: "replace", match: { agentId: "old" }, element: { asset: { path: "logo.png", type: "image", name: "Logo" }, duration: 3 } }]));
		const result = backend.state.results.at(-1);
		expect(result.results[0].ok).toBe(true);
		const replaced = elements(editor).find((e) => e.agentId === "old") as any;
		expect(replaced.mediaId).toBe(backend.state.saved[0]);
		expect(replaced.duration).toBe(T(3));
		expect(editor.media.getAssets().some((m) => m.id === backend.state.saved[0])).toBe(true);
	});
});

describe("keyframe values", () => {
	const keys = (editor: ReturnType<typeof setup>) => (elements(editor).find((e) => e.agentId === "box")?.animations as any)?.opacity?.keys?.length ?? 0;
	test("replace with an invalid value fails the op and keeps the existing keyframes", async () => {
		const editor = setup();
		const backend = fakeBackend();
		restore = backend.restore;
		await applyDraft(draft([{ op: "set", match: { agentId: "box" }, keyframes: [{ path: "opacity", time: 0, value: 0 }, { path: "opacity", time: 1, value: 1 }] }]));
		expect(keys(editor)).toBe(2);
		for (const extra of [{}, { atomic: true }]) {
			await applyDraft(draft([{ op: "set", match: { agentId: "box" }, keyframesMode: "replace", keyframes: [{ path: "opacity", time: 0, value: "not a number" }] }], extra));
			const result = backend.state.results.at(-1);
			expect(result.results[0].ok).toBe(false);
			expect(result.results[0].error).toContain("invalid value for opacity");
			expect(keys(editor)).toBe(2);
		}
	});
});
