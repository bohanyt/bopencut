import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from "bun:test";
import type { SceneTracks, TScene, TimelineElement, VideoElement } from "@/timeline";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";
import * as mediaProcessing from "@/media/processing";

// Stub the GPU modules (unused here) before EditorCore pulls them in; see scene-history.test.ts.
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
// Asset processing needs browser media APIs: an image is 400×200 whatever its bytes.
let restoreProcessing = () => {};
beforeEach(() => {
	const process = spyOn(mediaProcessing, "processMediaFile").mockImplementation(async ({ file, signal }) => {
		if (signal.aborted) return null;
		return file.name.endsWith(".mp4")
			? { name: file.name, type: "video", file, width: 400, height: 200, duration: 10, fps: 120 }
			: { name: file.name, type: "image", file, width: 400, height: 200 };
	});
	restoreProcessing = () => process.mockRestore();
});
const { EditorCore } = await import("@/core");
const { agentSnapshot, applyDraft, pollDraft, pollChanges } = await import("./bridge");
const { snapshotHistory } = await import("./history");
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
	let fail!: (error: Error) => void;
	const promise = new Promise<void>((resolve, reject) => { open = resolve; fail = reject; });
	return { promise, open, fail };
};

/**
 * Fake agent file API and storage. `slow` paths wait for their gate, `missing` paths 404.
 * Storage records saved and deleted media ids; `failSave`/`failDelete` make those calls throw.
 */
function fakeBackend({ slow = new Map<string, Promise<void>>(), missing = new Set<string>(), failSave = new Set<string>(), failDelete = false, slowDelete = Promise.resolve() } = {}) {
	const state = { saved: [] as string[], deleted: [] as string[], promoted: [] as string[], results: [] as any[], fileNames: new Map<string, string>() };
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
		promoteMediaAssets: async ({ ids }: { ids: string[] }) => {
			state.promoted.push(...ids);
		},
		saveMediaAsset: async ({ mediaAsset }: { mediaAsset: MediaAsset }) => {
			state.saved.push(mediaAsset.id);
			state.fileNames.set(mediaAsset.id, mediaAsset.file.name);
			// e.g. the file PUT succeeded, the metadata POST hit EPERM
			if (failSave.has(mediaAsset.file.name)) throw new Error("EPERM: operation not permitted, rename");
		},
		deleteMediaAsset: async ({ id }: { id: string }) => {
			await slowDelete;
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

/**
 * Project writes to storage: records each write's project id and agent ids; `fail` returns an error to
 * throw for a project, `wait` a promise the write waits for (or that rejects).
 */
function projectWrites({ fail, wait }: { fail?: (id: string) => string | null; wait?: (id: string) => Promise<void> | undefined } = {}) {
	const writes: { id: string; agentIds: string[] }[] = [];
	(storageService as any).saveProject = async ({ project }: { project: TProject }) => {
		const id = project.metadata.id;
		writes.push({ id, agentIds: project.scenes.flatMap(all).flatMap((e) => (e.agentId ? [e.agentId] : [])) });
		await wait?.(id);
		const error = fail?.(id);
		if (error) throw new Error(error);
	};
	return { writes, restore: () => delete (storageService as any).saveProject };
}

let restore = () => {};
afterEach(() => {
	restoreProcessing();
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

describe("drafts belong to the project session they were queued in", () => {
	const otherProject = (editor: ReturnType<typeof setup>) => {
		const scenes = [scene("main-q", { overlay: [], main: { id: "t-q", name: "Main", type: "video", muted: false, hidden: false, elements: [] }, audio: [] })];
		editor.project.setActiveProject({
			project: { metadata: { id: "q", name: "q", createdAt: new Date(0), updatedAt: new Date(0) }, scenes, currentSceneId: "main-q", settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } } } as unknown as TProject,
		});
		editor.scenes.setScenes({ scenes, activeSceneId: "main-q" });
	};

	test("opening another project while a draft loads or waits: nothing applies there, imports are removed", async () => {
		const editor = setup();
		const slow = gate();
		const backend = fakeBackend({ slow: new Map([["slow.png", slow.promise]]) });
		restore = backend.restore;
		const first = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("slow.png", "first") }]));
		const second = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("fast.png", "second") }]));
		await new Promise((resolve) => setTimeout(resolve, 10));
		otherProject(editor);
		slow.open();
		await Promise.all([first, second]);
		expect(elements(editor).map((e) => e.agentId).filter(Boolean)).toEqual([]);
		const [a, b] = backend.state.results;
		expect(a).toMatchObject({ projectId: "p", applied: false, rolledBack: true });
		expect(a.error).toContain("another project");
		expect(backend.state.deleted).toEqual(backend.state.saved);
		expect(b).toMatchObject({ projectId: "p", applied: false });
		expect(b.error).toContain("another project");
		// Neither the stale fetch nor the queued draft may start a new storage write.
		expect(backend.state.saved).toEqual([]);
	});

	test("a draft for another projectId is refused", async () => {
		setup();
		const backend = fakeBackend();
		restore = backend.restore;
		await applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("a.png", "a") }], { projectId: "zzz" }));
		expect(backend.state.results[0]).toMatchObject({ applied: false });
		expect(backend.state.results[0].error).toContain("not the open one");
		expect(backend.state.saved).toEqual([]);
	});

	test("reused media deleted while assets load stop the draft", async () => {
		const editor = setup();
		const slow = gate();
		const backend = fakeBackend({ slow: new Map([["slow.png", slow.promise]]) });
		restore = backend.restore;
		const run = applyDraft(draft([
			{ op: "add", track: { name: "Logos" }, element: { agent_id: "reuse", name: "reuse", mediaId: "m-new", start: 0, duration: 1 } },
			{ op: "add", track: { name: "Logos" }, element: image("slow.png", "slow") },
		]));
		await new Promise((resolve) => setTimeout(resolve, 10));
		editor.media.setAssets({ assets: [asset("m-old")] });
		slow.open();
		await run;
		expect(backend.state.results[0]).toMatchObject({ applied: false });
		expect(backend.state.results[0].error).toContain("m-new");
		expect(elements(editor).some((e) => e.agentId === "reuse" || e.agentId === "slow")).toBe(false);
		expect(backend.state.deleted).toEqual(backend.state.saved);
	});

	test("committed imports are promoted on disk once a write containing them is saved, also a later one", async () => {
		const editor = setup();
		const backend = fakeBackend();
		const disk = projectWrites();
		restore = () => {
			backend.restore();
			disk.restore();
		};
		// Saving is off (setup): the commit is not on disk, so nothing is promoted.
		await applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("first.png", "first") }]));
		expect(backend.state.results[0]).toMatchObject({ applied: true, saved: false, saveError: "saving is off" });
		expect(backend.state.promoted).toEqual([]);
		// Saving works: the next write contains both drafts, so both imports are promoted.
		editor.save.start();
		await applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("second.png", "second") }]));
		expect(backend.state.results[1]).toMatchObject({ applied: true, saved: true });
		expect([...backend.state.promoted].sort()).toEqual([...backend.state.saved].sort());
	});

	test("the draft's write fails, another project opens, the background retry lands: its imports are promoted then", async () => {
		const editor = setup();
		(editor.save as any).retryDelaysMs = [10];
		const backend = fakeBackend();
		const disk = projectWrites({ fail: (id) => (id === "p" && failing ? "EIO: i/o error" : null) });
		let failing = true;
		restore = () => {
			backend.restore();
			disk.restore();
		};
		editor.save.start();
		await applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("first.png", "first") }]));
		expect(backend.state.results[0]).toMatchObject({ applied: true, saved: false, saveError: "EIO: i/o error" });
		expect(backend.state.promoted).toEqual([]);
		failing = false;
		otherProject(editor);
		expect(await editor.save.settleProject("p")).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(backend.state.promoted).toEqual(backend.state.saved);
		// p was written from its own timeline (with the draft's clip), never q's.
		expect(disk.writes.filter((w) => w.id === "p").at(-1)?.agentIds).toContain("first");
		expect(disk.writes.filter((w) => w.id === "q").every((w) => !w.agentIds.includes("first"))).toBe(true);
	});

	test("a draft undone before its first successful write: the retry saves without it, and its import stays staged", async () => {
		const editor = setup();
		(editor.save as any).retryDelaysMs = [10];
		let failing = true;
		const backend = fakeBackend();
		const disk = projectWrites({ fail: (id) => (id === "p" && failing ? "EIO: i/o error" : null) });
		restore = () => {
			backend.restore();
			disk.restore();
		};
		editor.save.start();
		await applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("first.png", "first") }]));
		expect(backend.state.results[0]).toMatchObject({ applied: true, saved: false });
		editor.command.undo();
		expect(elements(editor).some((e) => e.agentId === "first")).toBe(false);
		failing = false;
		expect(await editor.save.settle()).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(disk.writes.at(-1)?.agentIds).not.toContain("first");
		expect(backend.state.promoted).toEqual([]);
	});

	test("a write that lands while the draft's unused imports are still being removed still promotes the used ones", async () => {
		const editor = setup();
		const removal = gate();
		const backend = fakeBackend({ slowDelete: removal.promise });
		const disk = projectWrites();
		restore = () => {
			backend.restore();
			disk.restore();
		};
		editor.save.start();
		const run = applyDraft(draft([
			{ op: "add", track: { name: "Logos" }, element: image("used.png", "used") },
			// Fails after its asset was imported: that import is unused and removed (slowly).
			{ op: "replace", match: { agentId: "nope" }, element: image("unused.png", "unused") },
		]));
		await new Promise((resolve) => setTimeout(resolve, 20));
		// The project closes while the removal runs: its background write has the draft.
		otherProject(editor);
		expect(await editor.save.settleProject("p")).toBeNull();
		removal.open();
		await run;
		await new Promise((resolve) => setTimeout(resolve, 5));
		const used = backend.state.fileNames;
		const usedId = [...used.entries()].find(([, name]) => name.includes("used") && !name.includes("unused"))?.[0];
		expect(usedId).toBeDefined();
		expect(backend.state.results[0]).toMatchObject({ applied: true, saved: true });
		expect(backend.state.promoted).toEqual([usedId as string]);
	});

	test("the draft's write hangs while another project opens and saves: the draft is not reported saved", async () => {
		const editor = setup();
		(editor.save as any).retryDelaysMs = [10];
		const backend = fakeBackend();
		const hung = gate();
		let pWrites = 0;
		const disk = projectWrites({ wait: (id) => (id === "p" && ++pWrites === 1 ? hung.promise : undefined) });
		restore = () => {
			backend.restore();
			disk.restore();
		};
		editor.save.start();
		const run = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("first.png", "first") }]));
		await new Promise((resolve) => setTimeout(resolve, 10));
		otherProject(editor);
		// q saves at once and is clean: that says nothing about p.
		expect(await editor.save.flush()).toBe(true);
		hung.fail(new Error("EIO: i/o error"));
		await run;
		expect(backend.state.results[0]).toMatchObject({ applied: true, saved: false, saveError: "EIO: i/o error" });
		expect(backend.state.promoted).toEqual([]);
		// The retry from p's snapshot lands, and the import is promoted then.
		expect(await editor.save.settleProject("p")).toBeNull();
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(backend.state.promoted).toEqual(backend.state.saved);
	});
});

describe("malformed element trees", () => {
	test("a null element inside a compound fails its op before anything is imported, and a result is written", async () => {
		const editor = setup();
		const backend = fakeBackend();
		restore = backend.restore;
		await applyDraft(draft([
			{ op: "add", track: { name: "Logos" }, element: image("ok.png", "ok") },
			{ op: "compound", name: "Broken", elements: [null] },
		]));
		const [result] = backend.state.results;
		expect(result).toMatchObject({ applied: false, rolledBack: true });
		expect(result.results[1].error).toContain("not an object");
		expect(backend.state.deleted).toEqual(backend.state.saved);
		expect(elements(editor).some((e) => e.agentId === "ok")).toBe(false);
	});
});

describe("the draft poller", () => {
	test("a project opened while draft.json is read: the draft is left for the next poll, not applied or refused", async () => {
		const editor = setup();
		const store = new Map<string, string>();
		const previousStorage = (globalThis as any).localStorage;
		(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
		const backend = fakeBackend();
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string, init?: unknown) => {
			if (String(url) === "/api/agent/draft") {
				// The human opens another project while the poll waits for the file.
				const scenes = [scene("main-q", { overlay: [], main: { id: "t-q", name: "Main", type: "video", muted: false, hidden: false, elements: [] }, audio: [] })];
				editor.project.setActiveProject({ project: { metadata: { id: "q", name: "q", createdAt: new Date(0), updatedAt: new Date(0) }, scenes, currentSceneId: "main-q", settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } } } as unknown as TProject });
				editor.scenes.setScenes({ scenes, activeSceneId: "main-q" });
				return new Response(JSON.stringify(draft([{ op: "delete", match: { agentId: "old" } }])));
			}
			return realFetch(url as never, init as never);
		}) as typeof fetch;
		// The open project is ready: loaded, its media loaded, nothing to save.
		(editor.project as any).isLoading = false;
		(editor.media as any).loadedProjectId = "p";
		(editor.media as any).isLoading = false;
		try {
			const { agentReadiness } = await import("./bridge");
			expect(agentReadiness().ready).toBe(true);
			await pollDraft();
		} finally {
			globalThis.fetch = realFetch;
			backend.restore();
			(globalThis as any).localStorage = previousStorage;
		}
		expect(backend.state.results).toEqual([]);
		expect([...store.keys()]).toEqual([]);
		expect(editor.project.getActive().metadata.id).toBe("q");
	});
});

describe("basedOn is checked before anything is imported", () => {
	const addOtherRoot = (editor: ReturnType<typeof setup>) => {
		const main = editor.scenes.getActiveScene().tracks.main;
		const other = scene("other", { overlay: [], main: { ...main, id: "t-other", elements: main.elements.map((element) => ({ ...element, id: "other-clip" })) }, audio: [] });
		editor.scenes.setScenes({ scenes: [...editor.scenes.getScenes(), { ...other, isMain: false }], activeSceneId: "main" });
	};

	test.each(["root", "project"])("rejects a cut based on another %s before staging assets", async (context) => {
		const editor = setup();
		addOtherRoot(editor);
		const backend = fakeBackend();
		restore = backend.restore;
		const basedOn = `before-switch-${context}`;
		snapshotHistory.record(basedOn, editor.scenes.getScenes(), { projectId: "p", rootSceneId: "main" });
		if (context === "root") {
			await editor.scenes.switchToScene({ sceneId: "other" });
		} else {
			const project = editor.project.getActive();
			editor.project.setActiveProject({ project: { ...project, metadata: { ...project.metadata, id: "other-project" } } });
		}
		const before = editor.scenes.getScenes();
		await applyDraft(draft([
			{ op: "cut", start: 0.5, end: 1 },
			{ op: "add", track: { name: "Logos" }, element: image("a.png", "a") },
		], { basedOn }));
		expect(editor.scenes.getScenes()).toBe(before);
		expect(backend.state.saved).toEqual([]);
		expect(backend.state.results[0]).toMatchObject({ applied: false, stale: true, sceneId: context === "root" ? "other" : "main" });
		expect(backend.state.results[0].error).toContain("basedOn belongs to a different project or root scene");
	});

	test("a draft queued on one root cannot cut another root before it starts", async () => {
		const editor = setup();
		addOtherRoot(editor);
		const backend = fakeBackend();
		restore = backend.restore;
		const run = applyDraft(draft([{ op: "cut", start: 0.5, end: 1 }]));
		const switched = editor.scenes.switchToScene({ sceneId: "other" });
		await switched;
		await run;
		expect(editor.scenes.getActiveScene().tracks.main.elements[0]?.duration).toBe(T(2));
		expect(backend.state.results[0]).toMatchObject({ applied: false, sceneId: "other" });
		expect(backend.state.results[0].error).toContain("another scene");
	});

	test("the poller refuses a root switch while reading a draft even if the editor becomes unready", async () => {
		const editor = setup();
		addOtherRoot(editor);
		const backend = fakeBackend();
		const pending = gate();
		const getIsLoading = spyOn(editor.project, "getIsLoading").mockReturnValue(false);
		const mediaLoaded = spyOn(editor.media, "isProjectMediaLoaded").mockReturnValue(true);
		const stored = new Map<string, string>();
		const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true, value: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
		});
		restore = () => {
			backend.restore();
			getIsLoading.mockRestore();
			mediaLoaded.mockRestore();
			if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
			else Reflect.deleteProperty(globalThis, "localStorage");
		};
		const read = globalThis.fetch;
		globalThis.fetch = (async (url, init) => {
			if (url !== "/api/agent/draft") return read(url, init);
			await pending.promise;
			return Response.json(draft([{ op: "cut", start: 0.5, end: 1 }]));
		}) as typeof fetch;
		const running = pollDraft();
		try {
			await editor.scenes.switchToScene({ sceneId: "other" });
			getIsLoading.mockReturnValue(true);
		} finally {
			pending.open();
			await running;
		}
		expect(editor.scenes.getActiveScene().tracks.main.elements[0]?.duration).toBe(T(2));
		expect(backend.state.results[0]).toMatchObject({ applied: false, sceneId: "other", error: expect.stringContaining("another scene") });
	});

	test("snapshots of different roots have distinct references in the same millisecond", async () => {
		const editor = setup();
		addOtherRoot(editor);
		setSystemTime(new Date());
		try {
			const a = agentSnapshot();
			await editor.scenes.switchToScene({ sceneId: "other" });
			const b = agentSnapshot();
			expect(a?.sceneId).toBe("main");
			expect(b?.sceneId).toBe("other");
			expect(a?.syncedAt).not.toBe(b?.syncedAt);
		} finally {
			setSystemTime();
		}
	});

	test("an unknown or malformed basedOn refuses the draft without importing", async () => {
		setup();
		const backend = fakeBackend();
		restore = backend.restore;
		await applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("a.png", "a") }], { basedOn: "2000-01-01T00:00:00.000Z" }));
		await applyDraft(draft([{ op: "set", match: { agentId: "old" }, params: { opacity: 0.5 } }], { basedOn: 42 }));
		const [unknown, malformed] = backend.state.results;
		expect(unknown).toMatchObject({ applied: false, stale: true });
		expect(malformed).toMatchObject({ applied: false, stale: true });
		expect(malformed.results[0]).toMatchObject({ match: { agentId: "old" }, stale: true });
		expect(malformed.error).toContain("syncedAt");
		expect(backend.state.saved).toEqual([]);
	});

	test("a draft whose every op is stale is not applied and not saved", async () => {
		const editor = setup();
		const backend = fakeBackend();
		const disk = projectWrites();
		restore = () => {
			backend.restore();
			disk.restore();
		};
		editor.save.start();
		snapshotHistory.record("before-the-user-edit", editor.scenes.getScenes(), { projectId: "p", rootSceneId: "main" });
		// The user moves "old" after the agent read the snapshot.
		const scenes = editor.scenes.getScenes().map((scene) => ({
			...scene,
			tracks: { ...scene.tracks, main: { ...scene.tracks.main, elements: scene.tracks.main.elements.map((e) => ({ ...e, startTime: T(1) })) } },
		})) as TScene[];
		editor.scenes.setScenes({ scenes, activeSceneId: "main" });
		await editor.save.settle();
		const writes = disk.writes.length;
		await applyDraft(draft([{ op: "set", match: { agentId: "old" }, start: 3 }], { basedOn: "before-the-user-edit" }));
		expect(backend.state.results[0]).toMatchObject({ applied: false, stale: true });
		expect(backend.state.results[0].results[0]).toMatchObject({ ok: false, stale: true, fields: ["start"] });
		expect(disk.writes.length).toBe(writes);
		expect(editor.save.getIsDirty()).toBe(false);
	});

	test("a drag started while the draft's assets load is not cancelled: the draft waits for the release", async () => {
		const editor = setup();
		const slow = gate();
		const backend = fakeBackend({ slow: new Map([["slow.png", slow.promise]]) });
		restore = backend.restore;
		const run = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("slow.png", "late") }]));
		await new Promise((resolve) => setTimeout(resolve, 5));
		// The user starts dragging a clip.
		(editor.timeline as any).previewOverlay.set("t-main:old", { startTime: T(1) });
		slow.open();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(backend.state.results).toEqual([]);
		expect(editor.timeline.isPreviewActive()).toBe(true);
		editor.timeline.discardPreview();
		await run;
		expect(backend.state.results[0]).toMatchObject({ applied: true });
		expect(elements(editor).some((e) => e.agentId === "late")).toBe(true);
	});

	test("a draft waiting for a preview wakes when the active scene changes", async () => {
		const editor = setup();
		const other = scene("other", { overlay: [], main: { id: "t-other", name: "Main", type: "video", muted: false, hidden: false, elements: [] }, audio: [] });
		editor.scenes.setScenes({ scenes: [...editor.scenes.getScenes(), { ...other, isMain: false }], activeSceneId: "main" });
		const slow = gate();
		const backend = fakeBackend({ slow: new Map([["slow.png", slow.promise]]) });
		restore = backend.restore;
		const run = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("slow.png", "late") }]));
		await Bun.sleep(5);
		editor.timeline.previewElements({
			updates: [{ trackId: "t-main", elementId: "old", updates: { startTime: T(1) } }],
		});
		slow.open();
		await Bun.sleep(20);
		expect(backend.state.results).toEqual([]);
		expect(editor.timeline.isPreviewActive()).toBe(true);

		await editor.scenes.switchToScene({ sceneId: "other" });
		const finished = await Promise.race([run.then(() => true), Bun.sleep(150).then(() => false)]);
		if (!finished) {
			// Wake the waiter on the old implementation so the test can finish before its deadline.
			editor.timeline.previewElements({
				updates: [{ trackId: "t-other", elementId: "old", updates: { startTime: T(2) } }],
			});
			editor.timeline.discardPreview();
			await run;
		}
		expect(finished).toBe(true);
		expect(backend.state.results[0]).toMatchObject({ applied: false, error: expect.stringContaining("another scene") });
	});

	test("a clip move started while the draft's assets load is not cut off: the draft waits for the release", async () => {
		const editor = setup();
		const { beginTimelineGesture } = await import("@/timeline/gesture-state");
		const slow = gate();
		const backend = fakeBackend({ slow: new Map([["slow.png", slow.promise]]) });
		restore = backend.restore;
		const run = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("slow.png", "late") }]));
		await new Promise((resolve) => setTimeout(resolve, 5));
		const release = beginTimelineGesture(); // the user grabs a clip
		slow.open();
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(backend.state.results).toEqual([]);
		release();
		await run;
		expect(backend.state.results[0]).toMatchObject({ applied: true });
	});

	test("another root scene opened while the draft loads: nothing applies to it", async () => {
		const editor = setup();
		const other = scene("other", { overlay: [], main: { id: "t-other", name: "Main", type: "video", muted: false, hidden: false, elements: [] }, audio: [] });
		editor.scenes.setScenes({ scenes: [...editor.scenes.getScenes(), { ...other, isMain: false }], activeSceneId: "main" });
		const slow = gate();
		const backend = fakeBackend({ slow: new Map([["slow.png", slow.promise]]) });
		restore = backend.restore;
		const run = applyDraft(draft([{ op: "add", track: { name: "Logos" }, element: image("slow.png", "late") }]));
		await new Promise((resolve) => setTimeout(resolve, 5));
		await editor.scenes.switchToScene({ sceneId: "other" });
		slow.open();
		await run;
		expect(backend.state.results[0]).toMatchObject({ applied: false });
		expect(backend.state.results[0].error).toContain("another scene");
		expect(elements(editor).some((e) => e.agentId === "late")).toBe(false);
		expect(backend.state.deleted).toEqual(backend.state.saved);
	});

	test("a changes request for an applied draft lists what the draft changed and what the user changed after it", async () => {
		const editor = setup();
		(editor.project as any).isLoading = false;
		const backend = fakeBackend();
		const store = new Map<string, string>();
		const previousStorage = (globalThis as any).localStorage;
		(globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
		const answered: any[] = [];
		const inner = globalThis.fetch;
		globalThis.fetch = (async (url: string, init?: { body?: string }) => {
			if (String(url) === "/api/agent/changes-request") return new Response(JSON.stringify({ rev: "changes-1", draft: "d-applied" }));
			if (String(url) === "/api/agent/changes-result") {
				answered.push(JSON.parse(init?.body ?? "{}"));
				return new Response("{}");
			}
			return inner(url as never, init as never);
		}) as typeof fetch;
		restore = () => {
			backend.restore();
			(globalThis as any).localStorage = previousStorage;
		};
		await applyDraft({ ...draft([{ op: "set", match: { agentId: "old" }, duration: 3 }]), rev: "d-applied" });
		// The user then trims the same clip.
		const scenes = editor.scenes.getScenes().map((scene) => ({
			...scene,
			tracks: { ...scene.tracks, main: { ...scene.tracks.main, elements: scene.tracks.main.elements.map((e) => ({ ...e, trimStart: T(0.5) })) } },
		})) as TScene[];
		editor.scenes.setScenes({ scenes, activeSceneId: "main" });
		await pollChanges();
		await pollChanges(); // answered once per rev
		expect(answered.length).toBe(1);
		expect(answered[0]).toMatchObject({ rev: "changes-1", projectId: "p", draft: "d-applied" });
		expect(answered[0].draftChanges.map((c: any) => [c.agentId, c.field, c.from, c.to])).toEqual([["old", "duration", 2, 3]]);
		expect(answered[0].changes.map((c: any) => [c.agentId, c.field, c.from, c.to])).toEqual([["old", "trimStart", 0, 0.5]]);
		expect(typeof answered[0].syncedAt).toBe("string");
	});

	test("a words op keeps the words with the media once the draft commits; unknown media fail the draft", async () => {
		const editor = setup();
		const backend = fakeBackend();
		const stored: { id: string; words: unknown }[] = [];
		(storageService as any).setMediaWords = async ({ id, words }: { id: string; words: unknown }) => { stored.push({ id, words }); };
		restore = () => {
			backend.restore();
			delete (storageService as any).setMediaWords;
		};
		const words = [{ text: "hi", start: 0.2, end: 0.5 }];
		await applyDraft(draft([{ op: "words", mediaId: "m-old", words }]));
		expect(backend.state.results[0]).toMatchObject({ applied: true, results: [{ ok: true, mediaId: "m-old", words: 1 }] });
		expect(stored).toEqual([{ id: "m-old", words }]);
		expect(editor.media.getAssets().find((a) => a.id === "m-old")?.words).toEqual(words);
		await applyDraft(draft([{ op: "words", mediaId: "nope", words }]));
		expect(backend.state.results[1]).toMatchObject({ applied: false });
		expect(stored.length).toBe(1);
	});

	test("words are stored before the timeline changes, and put back when the draft does not apply", async () => {
		const editor = setup();
		const backend = fakeBackend();
		const calls: { id: string; words: unknown }[] = [];
		(storageService as any).setMediaWords = async ({ id, words }: { id: string; words: unknown }) => { calls.push({ id, words }); };
		restore = () => {
			backend.restore();
			delete (storageService as any).setMediaWords;
		};
		const words = [{ text: "hi", start: 0.2, end: 0.5 }];
		await applyDraft(draft([{ op: "words", mediaId: "m-old", words }, { op: "set", match: { agentId: "missing" }, start: 1 }], { atomic: true }));
		expect(backend.state.results[0]).toMatchObject({ applied: false });
		expect(calls).toEqual([{ id: "m-old", words }, { id: "m-old", words: undefined }]);
		expect(editor.media.getAssets().find((a) => a.id === "m-old")?.words).toBeUndefined();
	});

	test("cut: words on an add with real media lookups; a later set uses the words its import brought", async () => {
		const editor = setup();
		const backend = fakeBackend();
		restore = backend.restore;
		const words = [{ text: "x", start: 0.5, end: 1.1 }];
		editor.media.setAssets({ assets: [...editor.media.getAssets(), asset("vid", { type: "video", duration: 10, words } as never)] });
		await applyDraft(draft([{ op: "add", track: { name: "Clips", type: "video" }, element: { agent_id: "near", name: "near", mediaId: "vid", start: 20, duration: 0.3, trimStart: 0.6, cut: "words" } }]));
		expect(backend.state.results[0]).toMatchObject({ applied: true, results: [{ ok: true }] });
		const near = elements(editor).find((e) => e.agentId === "near")!;
		expect((near.trimStart + near.duration) / TICKS_PER_SECOND).toBeGreaterThanOrEqual(1.1 - 0.02);
		await applyDraft(draft([
			{ op: "add", track: { name: "Talk", type: "video" }, element: { agent_id: "talk", name: "talk", asset: { path: "talk.mp4", type: "video", name: "talk", words }, start: 40, duration: 1, trimStart: 0.6, cut: "words" } },
			{ op: "set", match: { agentId: "talk" }, trimStart: 0.65, duration: 0.2, cut: "words" },
		]));
		expect(backend.state.results[1]).toMatchObject({ applied: true, results: [{ ok: true }, { ok: true }] });
	});

	test("words that cannot be put back are reported: the draft is not rolled back", async () => {
		setup();
		const backend = fakeBackend();
		let calls = 0;
		(storageService as any).setMediaWords = async () => {
			calls++;
			if (calls > 1) throw new Error("EIO");
		};
		restore = () => {
			backend.restore();
			delete (storageService as any).setMediaWords;
		};
		await applyDraft(draft([{ op: "words", mediaId: "m-old", words: [{ text: "hi", start: 0, end: 1 }] }, { op: "set", match: { agentId: "missing" }, start: 1 }], { atomic: true }));
		expect(backend.state.results[0]).toMatchObject({ applied: false, rolledBack: false });
		expect(backend.state.results[0].cleanup.failed).toEqual([{ id: "words:m-old", error: "EIO" }]);
	});
});


describe("media import lifecycle", () => {
	test.each([
		[30, 60, 60_000 / 1_001],
		[24, 30, 30_000 / 1_001],
		[30, 30, 30_000 / 1_001],
	])("a first paste keeps a faster source already published to the bin (%f → %f, then %f)", async (initialFps, faster, slower) => {
		const editor = setup();
		const backend = fakeBackend();
		restore = backend.restore;
		const { AddMediaAssetCommand, BatchCommand, InsertElementCommand } = await import("@/commands");
		const { buildElementFromMedia } = await import("@/timeline/element-utils");
		await editor.project.updateSettings({ settings: { fps: { numerator: initialFps, denominator: 1 } }, pushHistory: false });
		const current = editor.scenes.getActiveScene();
		const empty = { ...current, tracks: { ...current.tracks, main: { ...current.tracks.main, elements: [] }, overlay: [] } };
		editor.scenes.setScenes({ scenes: [empty], activeSceneId: empty.id });
		const importVideo = (fps: number) => editor.media.addMediaAsset({
			projectId: "p",
			asset: { name: `${fps}.mp4`, type: "video", file: new File(["footage"], `${fps}.mp4`), fps, width: 640, height: 360 },
		});
		expect(await importVideo(faster)).not.toBeNull();
		const source = await importVideo(slower);
		if (!source) throw new Error("Expected a saved import");
		editor.command.execute({ command: new BatchCommand([
			new AddMediaAssetCommand({ projectId: "p", assetId: source.id }),
			new InsertElementCommand({
				element: buildElementFromMedia({ mediaId: source.id, mediaType: source.type, name: source.name, startTime: T(0), duration: T(1) }),
				placement: { mode: "explicit", trackId: empty.tracks.main.id },
			}),
		]) });
		const expectFasterRate = () => expect(editor.project.getActive().settings.fps).toEqual({ numerator: faster, denominator: 1 });
		expectFasterRate();
		editor.command.undo();
		expectFasterRate();
		editor.command.redo();
		expectFasterRate();
		await editor.media.settleBinWrites("p");
	});

	test.each([30, 31])("first video can initialize a default or incompatible project rate (%d)", async (initialFps) => {
		const editor = setup();
		const backend = fakeBackend();
		restore = backend.restore;
		const { InsertElementCommand } = await import("@/commands");
		const { buildElementFromMedia } = await import("@/timeline/element-utils");
		await editor.project.updateSettings({ settings: { fps: { numerator: initialFps, denominator: 1 } }, pushHistory: false });
		const current = editor.scenes.getActiveScene();
		const empty = { ...current, tracks: { ...current.tracks, main: { ...current.tracks.main, elements: [] }, overlay: [] } };
		editor.scenes.setScenes({ scenes: [empty], activeSceneId: empty.id });
		const source = await editor.media.addMediaAsset({
			projectId: "p", asset: { name: "footage.mp4", type: "video", file: new File(["footage"], "footage.mp4"), fps: 30_000 / 1_001 },
		});
		if (!source) throw new Error("Expected a saved import");
		const command = new InsertElementCommand({
			element: buildElementFromMedia({ mediaId: source.id, mediaType: source.type, name: source.name, startTime: T(0), duration: T(1) }),
			placement: { mode: "explicit", trackId: empty.tracks.main.id },
		});
		editor.command.execute({ command });
		expect(editor.project.getActive().settings.fps).toEqual({ numerator: 30_000, denominator: 1_001 });
		editor.command.undo();
		expect(editor.project.getActive().settings.fps).toEqual({ numerator: initialFps, denominator: 1 });
		editor.command.redo();
		expect(editor.project.getActive().settings.fps).toEqual({ numerator: 30_000, denominator: 1_001 });
	});

	test("a stalled upload does not hold the next import in the same project", async () => {
		const editor = setup();
		const started = gate();
		const finish = gate();
		const save = spyOn(storageService, "saveMediaAsset").mockResolvedValue();
		save.mockImplementationOnce(async () => {
			started.open();
			await finish.promise;
		});
		restore = () => save.mockRestore();
		const session = editor.media.startImport()!;
		const first = editor.media.importFile({ session, file: new File(["first"], "slow.png") });
		await started.promise;
		const second = editor.media.importFile({ session, file: new File(["second"], "quick.png") });
		try {
			expect(await Promise.race([second, Bun.sleep(100).then(() => null)])).toMatchObject({ name: "quick.png" });
		} finally {
			finish.open();
			await Promise.all([first, second]);
		}
	});

	test("undo and redo of a paste or library insertion include its new source", async () => {
		const editor = setup();
		const { AddMediaAssetCommand, BatchCommand, InsertElementCommand } = await import("@/commands");
		const { buildElementFromMedia } = await import("@/timeline/element-utils");
		const backend = fakeBackend();
		restore = backend.restore;
		const source = await editor.media.importFile({
			session: editor.media.startImport()!, file: new File(["new"], "pasted.png", { type: "image/png" }),
		});
		if (!source) throw new Error("Expected a saved import");
		const add = new AddMediaAssetCommand({ projectId: "p", assetId: source.id });
		const insert = new InsertElementCommand({
			element: buildElementFromMedia({ mediaId: source.id, mediaType: source.type, name: source.name, startTime: T(3), duration: T(1) }),
			placement: { mode: "explicit", trackId: "t-main" },
		});
		editor.command.execute({ command: new BatchCommand([add, insert]) });
		const refersToSource = (element: TimelineElement) => "mediaId" in element && element.mediaId === source.id;
		expect(elements(editor).some(refersToSource)).toBe(true);
		editor.command.undo();
		expect(elements(editor).some(refersToSource)).toBe(false);
		expect(editor.media.getAssets().some(({ id }) => id === source.id)).toBe(false);
		await editor.media.settleBinWrites("p");
		expect(backend.state.deleted).toEqual([source.id]);
		editor.command.redo();
		expect(elements(editor).some(refersToSource)).toBe(true);
		expect(editor.media.getAssets().some(({ id }) => id === source.id)).toBe(true);
		await editor.media.settleBinWrites("p");
		expect(backend.state.saved).toEqual([source.id, source.id]);
	});

	test.each(["pending", "accepted", "accepted then removed", "removed in another tab"])("reopening during an import (%s) loads media and reconciles the response once", async (status) => {
		const editor = setup();
		const project = editor.project.getActive();
		const started = gate();
		const finish = gate();
		let onDisk: MediaAsset | undefined;
		const save = spyOn(storageService, "saveMediaAsset").mockImplementation(async ({ mediaAsset }) => {
			if (status !== "pending") onDisk = mediaAsset;
			started.open();
			await finish.promise;
			if (status === "pending") onDisk = mediaAsset;
		});
		const remove = spyOn(storageService, "deleteMediaAsset").mockImplementation(async () => { onDisk = undefined; });
		const present = spyOn(storageService, "hasStoredMediaAsset").mockImplementation(async () => !!onDisk);
		const load = spyOn(storageService, "loadAllMediaAssets").mockImplementation(async () =>
			onDisk ? [asset("m-old"), { ...onDisk, url: "/stored.mp4" }] : [asset("m-old")],
		);
		restore = () => { save.mockRestore(); remove.mockRestore(); present.mockRestore(); load.mockRestore(); };
		const importing = editor.media.importFile({ session: editor.media.startImport()!, file: new File(["movie"], "movie.mp4", { type: "video/mp4" }) });
		await started.promise;
		if (status === "removed in another tab") onDisk = undefined;
		editor.project.closeProject();
		editor.project.setActiveProject({ project });
		editor.scenes.setScenes({ scenes: project.scenes, activeSceneId: "main" });
		const reopening = editor.media.loadProjectMedia({ projectId: "p" });
		try {
			expect(await Promise.race([reopening.then(() => true), Bun.sleep(100).then(() => false)])).toBe(true);
			const opened = editor.media.getAssets();
			expect(opened.map(({ name }) => name)).toEqual(status === "pending" || status === "removed in another tab" ? ["m-old"] : ["m-old", "movie.mp4"]);
			if (status === "accepted then removed") editor.media.removeMediaAsset({ projectId: "p", id: opened[1].id });
			finish.open();
			expect(await importing).toBeNull();
			expect(editor.media.getAssets().map(({ name }) => name)).toEqual(status.includes("removed") ? ["m-old"] : ["m-old", "movie.mp4"]);
			expect(editor.project.getActive().settings.fps).toEqual({ numerator: 30, denominator: 1 });
		} finally {
			finish.open();
			await Promise.all([reopening, importing]);
			await editor.media.settleBinWrites("p");
		}
	});

	test("project deletion proceeds while a media response is pending", async () => {
		const editor = setup();
		const started = gate();
		const finish = gate();
		const save = spyOn(storageService, "saveMediaAsset").mockImplementation(async () => {
			started.open();
			await finish.promise;
		});
		const remove = spyOn(storageService, "deleteProject").mockResolvedValue();
		restore = () => { save.mockRestore(); remove.mockRestore(); };
		const importing = editor.media.importFile({ session: editor.media.startImport()!, file: new File(["x"], "slow.png") });
		await started.promise;
		const deleting = editor.project.deleteProjects({ ids: ["p"] });
		try {
			expect(await Promise.race([deleting.then(() => true), Bun.sleep(100).then(() => false)])).toBe(true);
			expect(remove).toHaveBeenCalledWith({ id: "p" });
		} finally {
			finish.open();
			await Promise.all([deleting, importing]);
		}
		expect(editor.project.getActiveOrNull()).toBeNull();
	});

	test("reopening loads unaffected media while a bin deletion is pending", async () => {
		const editor = setup();
		const removal = gate();
		const started = gate();
		const project = editor.project.getActive();
		const remove = spyOn(storageService, "deleteMediaAsset").mockImplementation(async () => {
			started.open();
			await removal.promise;
		});
		const load = spyOn(storageService, "loadAllMediaAssets").mockResolvedValue([asset("m-old"), asset("m-new")]);
		restore = () => { remove.mockRestore(); load.mockRestore(); };
		editor.media.removeMediaAsset({ projectId: "p", id: "m-new" });
		await started.promise;
		editor.project.closeProject();
		editor.project.setActiveProject({ project });
		editor.scenes.setScenes({ scenes: project.scenes, activeSceneId: "main" });
		const reopening = editor.media.loadProjectMedia({ projectId: "p" });
		try {
			expect(await Promise.race([reopening.then(() => true), Bun.sleep(100).then(() => false)])).toBe(true);
			expect(editor.media.getAssets().map(({ id }) => id)).toEqual(["m-old"]);
		} finally {
			removal.open();
			await reopening;
		}
	});

	test("an upload published on disk survives a switch while its response is pending", async () => {
		const editor = setup();
		const before = editor.project.getActive();
		const session = editor.media.startImport()!;
		const started = gate();
		const finish = gate();
		const stored = new Map<string, MediaAsset>();
		const destinations: string[] = [];
		const save = spyOn(storageService, "saveMediaAsset").mockImplementation(async ({ projectId, mediaAsset }) => {
			destinations.push(projectId);
			stored.set(mediaAsset.id, mediaAsset);
			started.open();
			await finish.promise;
		});
		const remove = spyOn(storageService, "deleteMediaAsset").mockImplementation(async ({ id }) => {
			stored.delete(id);
		});
		const load = spyOn(storageService, "loadAllMediaAssets").mockImplementation(async () => [...stored.values()]);
		restore = () => { save.mockRestore(); remove.mockRestore(); load.mockRestore(); };

		const pending = editor.media.importFile({ session, file: new File(["first"], "fast.mp4") });
		await started.promise;
		editor.project.closeProject();
		editor.project.setActiveProject({ project: { ...before, metadata: { ...before.metadata, id: "q" } } });
		finish.open();
		expect(await pending).toBeNull();
		expect(await editor.media.importFile({ session, file: new File(["second"], "next.mp4") })).toBeNull();
		expect(destinations).toEqual(["p"]);
		expect(editor.media.getAssets()).toEqual([]);
		expect(editor.project.getActive().settings.fps).toEqual({ numerator: 30, denominator: 1 });

		editor.project.closeProject();
		editor.project.setActiveProject({ project: before });
		editor.scenes.setScenes({ scenes: before.scenes, activeSceneId: "main" });
		await editor.media.loadProjectMedia({ projectId: "p" });
		expect(editor.media.getAssets().map(({ name }) => name)).toEqual(["fast.mp4"]);
		expect(remove).not.toHaveBeenCalled();
		expect(editor.project.getActive().settings.fps).toEqual({ numerator: 30, denominator: 1 });
	});

	test("rejected and discarded imports release their source and thumbnail URLs", async () => {
		const editor = setup();
		const save = spyOn(storageService, "saveMediaAsset").mockRejectedValue(new Error("write failed"));
		const remove = spyOn(storageService, "deleteMediaAsset").mockResolvedValue();
		const revoked = spyOn(URL, "revokeObjectURL");
		restore = () => { save.mockRestore(); remove.mockRestore(); revoked.mockRestore(); };
		const file = new File(["new"], "new.png");
		const attempt = () => ({
			name: file.name,
			type: "image" as const,
			file,
			url: URL.createObjectURL(file),
			thumbnailUrl: URL.createObjectURL(file),
		});
		const normal = attempt();
		expect(await editor.media.addMediaAsset({ projectId: "p", asset: normal })).toBeNull();
		const failedStage = attempt();
		await expect(editor.media.stageMediaAsset({ projectId: "p", asset: failedStage })).rejects.toThrow("write failed");
		save.mockResolvedValue();
		const staged = await editor.media.stageMediaAsset({ projectId: "p", asset: attempt() });
		remove.mockRejectedValueOnce(new Error("cleanup failed"));
		expect((await editor.media.discardStagedMediaAssets({ ids: [staged.id] })).failed).toHaveLength(1);
		for (const asset of [normal, failedStage, staged]) {
			expect(revoked).toHaveBeenCalledWith(asset.url);
			expect(revoked).toHaveBeenCalledWith(asset.thumbnailUrl);
		}
		expect(await editor.media.discardStagedMediaAssets({ ids: [staged.id] })).toEqual({ removed: [staged.id], failed: [] });
	});

	test("undo restores the removed item alongside a later import", async () => {
		const editor = setup();
		const backend = fakeBackend();
		const deleting = gate();
		const deletes = spyOn(storageService, "deleteMediaAsset").mockImplementation(async () => deleting.promise);
		restore = () => { deletes.mockRestore(); backend.restore(); };
		const session = editor.media.startImport()!;
		editor.media.removeMediaAsset({ projectId: "p", id: "m-old" });
		deleting.open();
		const later = await editor.media.importFile({ session, file: new File(["later"], "later.png") });
		expect(later).not.toBeNull();
		editor.command.undo();
		expect(editor.media.getAssets().map(({ id }) => id)).toEqual(["m-old", "m-new", later!.id]);
		await editor.media.settleBinWrites("p");
		expect(backend.state.saved).toEqual([later!.id, "m-old"]);

		editor.command.redo();
		editor.command.undo();
		await editor.media.settleBinWrites("p");
		expect(backend.state.saved).toEqual([later!.id, "m-old", "m-old"]);
	});

	test("undo persists the source for a fresh tab while the delete response is stalled", async () => {
		const editor = setup();
		const project = editor.project.getActive();
		const removal = gate();
		const started = gate();
		const restored = gate();
		const stored = new Map([["m-old", asset("m-old")], ["m-new", asset("m-new")]]);
		const remove = spyOn(storageService, "deleteMediaAsset").mockImplementation(async () => {
			stored.delete("m-new");
			started.open();
			await removal.promise;
		});
		const save = spyOn(storageService, "saveMediaAsset").mockImplementation(async ({ mediaAsset }) => {
			stored.set(mediaAsset.id, { ...mediaAsset, url: "/stored.png" });
			restored.open();
		});
		const load = spyOn(storageService, "loadAllMediaAssets").mockImplementation(async () => [...stored.values()]);
		restore = () => { remove.mockRestore(); save.mockRestore(); load.mockRestore(); };
		editor.media.removeMediaAsset({ projectId: "p", id: "m-new" });
		await started.promise;
		editor.command.undo();
		try {
			expect(await Promise.race([restored.promise.then(() => true), Bun.sleep(100).then(() => false)])).toBe(true);
			const fresh = setup();
			fresh.media.clearAllAssets();
			fresh.project.setActiveProject({ project });
			fresh.scenes.setScenes({ scenes: project.scenes, activeSceneId: "main" });
			await fresh.media.loadProjectMedia({ projectId: "p" });
			expect(fresh.media.getAssets().map(({ id }) => id)).toEqual(["m-old", "m-new"]);
		} finally {
			removal.open();
			await editor.media.settleBinWrites("p");
		}
		expect(save).toHaveBeenCalledTimes(1);
	});

	test("an older delete response cannot forget a newer pending bin removal", async () => {
		const editor = setup();
		const project = editor.project.getActive();
		const firstResponse = gate();
		const secondResponse = gate();
		const remove = spyOn(storageService, "deleteMediaAsset").mockImplementation(({ id }) =>
			id === "m-old" ? firstResponse.promise : secondResponse.promise,
		);
		const save = spyOn(storageService, "saveMediaAsset").mockResolvedValue();
		const load = spyOn(storageService, "loadAllMediaAssets").mockResolvedValue([asset("m-old"), asset("m-new")]);
		restore = () => { remove.mockRestore(); save.mockRestore(); load.mockRestore(); };
		editor.media.removeMediaAsset({ projectId: "p", id: "m-old" });
		editor.command.undo();
		await editor.media.settleBinWrites("p");
		editor.media.removeMediaAsset({ projectId: "p", id: "m-new" });
		firstResponse.open();
		await Bun.sleep(0);
		editor.project.closeProject();
		editor.project.setActiveProject({ project });
		editor.scenes.setScenes({ scenes: project.scenes, activeSceneId: "main" });
		try {
			await editor.media.loadProjectMedia({ projectId: "p" });
			expect(editor.media.getAssets().map(({ id }) => id)).toEqual(["m-old"]);
		} finally {
			secondResponse.open();
			await editor.media.settleBinWrites("p");
		}
	});

	test.each([false, true])("a late upload does not duplicate or revive a loaded entry (removed: %s)", async (removed) => {
		const editor = setup();
		const file = new File(["png"], "upload.png", { type: "image/png" });
		const url = URL.createObjectURL(file);
		const started = Promise.withResolvers<MediaAsset>();
		const finish = gate();
		const save = spyOn(storageService, "saveMediaAsset").mockImplementation(async ({ mediaAsset }) => {
			started.resolve(mediaAsset);
			await finish.promise;
		});
		const remove = spyOn(storageService, "deleteMediaAsset").mockResolvedValue();
		const load = spyOn(storageService, "loadAllMediaAssets");
		const revoke = spyOn(URL, "revokeObjectURL");
		restore = () => { save.mockRestore(); remove.mockRestore(); load.mockRestore(); revoke.mockRestore(); };
		const pending = editor.media.addMediaAsset({ projectId: "p", asset: { name: file.name, type: "image", file, url } });
		const written = await started.promise;
		const loaded = { ...written, url: "/stored.png" };
		load.mockResolvedValue([loaded]);
		await editor.media.loadProjectMedia({ projectId: "p" });
		if (removed) editor.media.removeMediaAsset({ projectId: "p", id: written.id });
		finish.open();
		expect(await pending).toBe(removed ? null : loaded);
		expect(editor.media.getAssets().filter(({ id }) => id === written.id)).toEqual(removed ? [] : [loaded]);
		expect(revoke).toHaveBeenCalledWith(url);
	});
});
