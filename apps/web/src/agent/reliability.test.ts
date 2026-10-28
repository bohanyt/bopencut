import { afterEach, describe, expect, mock, test } from "bun:test";
import type { GraphicElement, SceneTracks, TScene, TimelineElement, VideoElement } from "@/timeline";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";

// Stub the GPU modules (unused here) before EditorCore pulls them in; see scene-history.test.ts.
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { EditorCore } = await import("@/core");
const { applyDraft, agentReadiness } = await import("./bridge");
const { storageService } = await import("@/services/storage/service");

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const el = (type: string, id: string, start: number, duration: number, extra: Record<string, unknown> = {}) =>
	({ id, type, name: id, startTime: T(start), duration: T(duration), trimStart: T(0), trimEnd: T(0), params: {}, ...extra }) as unknown as TimelineElement;
const scene = (id: string, tracks: SceneTracks): TScene => ({ id, name: id, isMain: true, tracks, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0) });

/** Main track: five visuals v1–v5 (2 s each, agentIds clip-1…clip-5); a graphic "box" on an overlay. */
function timeline(): TScene[] {
	const visuals = [1, 2, 3, 4, 5].map((n) => el("video", `v${n}`, (n - 1) * 2, 2, { agentId: `clip-${n}`, mediaId: "m-1", sourceDuration: T(10), trimEnd: T(8) }));
	return [scene("main", {
		overlay: [{ id: "t-g", name: "Shapes", type: "graphic", hidden: false, elements: [el("graphic", "box", 0, 4, { agentId: "box", definitionId: "line", params: { "transform.scaleX": 0.5, "transform.scaleY": 0.5, drawProgress: 1 } }) as GraphicElement] }],
		main: { id: "t-main", name: "Main", type: "video", muted: false, hidden: false, elements: visuals as VideoElement[] },
		audio: [],
	})];
}

const asset = (id: string, extra: Partial<MediaAsset> = {}) => ({ id, name: id, type: "image", file: new File(["x"], `${id}.png`, { type: "image/png" }), width: 400, height: 200, ...extra }) as MediaAsset;

function setup() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	editor.save.pause();
	const scenes = timeline();
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) }, scenes, currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	editor.media.setAssets({ assets: [asset("m-1"), asset("logo-a"), asset("clip-b", { type: "video", duration: 6, width: 1920, height: 1080 })] });
	return editor;
}
const mainScene = (editor: ReturnType<typeof setup>) => editor.scenes.getScenes().find((s) => s.id === "main") as TScene;
const all = (s: TScene) => [...s.tracks.overlay, s.tracks.main, ...s.tracks.audio].flatMap((track): TimelineElement[] => track.elements);
const find = (editor: ReturnType<typeof setup>, agentId: string) => all(mainScene(editor)).find((e) => e.agentId === agentId || e.id === agentId);
const state = (editor: ReturnType<typeof setup>) => JSON.stringify(editor.scenes.getScenes().map((s) => ({ id: s.id, tracks: s.tracks })));
const draft = (ops: unknown[], extra: Record<string, unknown> = {}) => ({ schema: "opencut-agent-draft-1", rev: "r", ops, ...extra }) as Parameters<typeof applyDraft>[0];

/** Runs `action` with fetch mocked: asset files fail to load (as a failed media save does); returns the posted draft result. */
async function withAgentApi(action: () => Promise<void>): Promise<any> {
	const posted: any[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string, init?: { body?: string }) => {
		if (String(url).startsWith("/api/agent/file")) return { ok: false, status: 500, json: async () => ({}) };
		if (String(url) === "/api/agent/applied") posted.push(JSON.parse(init?.body ?? "{}"));
		return { ok: true, json: async () => ({}) };
	}) as unknown as typeof fetch;
	try {
		await action();
	} finally {
		globalThis.fetch = realFetch;
	}
	return posted.at(-1);
}

afterEach(() => EditorCore.reset());

describe("transactional drafts", () => {
	test("5 deletes + 5 compounds whose assets fail: nothing is applied and every failure is reported", async () => {
		const editor = setup();
		const before = state(editor);
		const ops = [
			...[1, 2, 3, 4, 5].map((n) => ({ op: "delete", match: { agentId: `clip-${n}` } })),
			...[1, 2, 3, 4, 5].map((n) => ({
				op: "compound", agent_id: `scene-${n}`, name: `Scene ${n}`, start: (n - 1) * 2, track: { name: "Main" },
				elements: [{ agent_id: `logo-${n}`, name: `Logo ${n}`, asset: { path: `logos/${n}.png`, type: "image", name: `logo ${n}` }, start: 0, duration: 2, track: { name: "Logos" } }],
			})),
		];
		const result = await withAgentApi(() => applyDraft(draft(ops)));
		// Old behaviour: the deletes applied and the timeline lost all five visuals.
		expect(state(editor)).toBe(before);
		expect(all(mainScene(editor)).filter((e) => e.agentId?.startsWith("clip-")).length).toBe(5);
		expect(editor.command.canUndo()).toBe(false);
		expect(result.applied).toBe(false);
		expect(result.ok).toBe(false);
		expect(result.results).toHaveLength(10);
		expect(result.results.every((r: any) => r.ok === false)).toBe(true);
		expect(result.results.slice(0, 5).every((r: any) => r.skipped === true)).toBe(true);
		for (const [n, r] of result.results.slice(5).entries()) expect(r.error).toContain(`logos/${n + 1}.png`);
	});

	test("a missing mediaId fails the whole draft before anything changes", async () => {
		const editor = setup();
		const before = state(editor);
		const result = await withAgentApi(() => applyDraft(draft([
			{ op: "delete", match: { agentId: "clip-1" } },
			{ op: "add", track: { name: "Logos" }, element: { agent_id: "l1", name: "L1", mediaId: "not-there", start: 0, duration: 1 } },
		])));
		expect(state(editor)).toBe(before);
		expect(result.applied).toBe(false);
		expect(result.results[1].error).toContain("not-there");
	});

	test("atomic: a failing op rolls back the ops before it", async () => {
		const editor = setup();
		const before = state(editor);
		const result = await withAgentApi(() => applyDraft(draft([
			{ op: "delete", match: { agentId: "clip-1" } },
			{ op: "set", match: { agentId: "nope" }, start: 1 },
		], { atomic: true })));
		expect(state(editor)).toBe(before);
		expect(result.applied).toBe(false);
		expect(result.results[0]).toMatchObject({ ok: false, skipped: true });
		expect(result.results[1].ok).toBe(false);
	});

	test("without atomic, failed ops are skipped and the rest applies (unchanged contract)", async () => {
		const editor = setup();
		const result = await withAgentApi(() => applyDraft(draft([
			{ op: "delete", match: { agentId: "clip-1" } },
			{ op: "set", match: { agentId: "nope" }, start: 1 },
		])));
		expect(find(editor, "clip-1")).toBeUndefined();
		expect(result.applied).toBe(true);
		expect(result.saved).toBe(true);
		expect(result.results.map((r: any) => r.ok)).toEqual([true, false]);
	});
});

describe("replace", () => {
	test("puts a compound in place of a clip on the same track, keeping agentId and span, as one undo", async () => {
		const editor = setup();
		const before = state(editor);
		const result = await withAgentApi(() => applyDraft(draft([
			{ op: "replace", match: { agentId: "clip-3" }, element: { name: "Scene 3", compound: { elements: [{ agent_id: "logo", name: "Logo", mediaId: "logo-a", start: 0, duration: 2, track: { name: "Logos" } }] } } },
		])));
		const r = result.results[0];
		expect(r.ok).toBe(true);
		expect(r.replaced).toEqual({ sceneId: "main", id: "v3" });
		const main = mainScene(editor).tracks.main.elements;
		expect(main.map((e) => e.agentId)).toEqual(["clip-1", "clip-2", "clip-4", "clip-5", "clip-3"]);
		const replacement = main.find((e) => e.agentId === "clip-3") as TimelineElement & { sceneId: string };
		expect(replacement.type).toBe("compound");
		expect(replacement.startTime).toBe(T(4));
		expect(replacement.duration).toBe(T(2));
		const content = editor.scenes.getScenes().find((s) => s.id === replacement.sceneId) as TScene;
		expect((all(content)[0] as any).mediaId).toBe("logo-a");
		editor.command.undo();
		expect(state(editor)).toBe(before);
	});

	test("a replacement that cannot be built leaves the original in place", async () => {
		const editor = setup();
		const before = state(editor);
		const result = await withAgentApi(() => applyDraft(draft([{ op: "replace", match: { agentId: "clip-2" }, element: { name: "Empty", compound: {} } }])));
		expect(result.results[0].ok).toBe(false);
		expect(state(editor)).toBe(before);
	});
});

describe("set keyframes and mediaId reuse", () => {
	const keys = (e: TimelineElement | undefined, path: string) => ((e?.animations?.[path] as any)?.keys ?? []).map((k: any) => [k.time / TICKS_PER_SECOND, k.value, k.segmentToNext]);

	test("merge upserts keys, replace drops the old ones; graphic params and scale resolve like add", async () => {
		const editor = setup();
		await withAgentApi(() => applyDraft(draft([
			{ op: "set", match: { agentId: "box" }, keyframes: [{ path: "opacity", time: 0, value: 0 }, { path: "opacity", time: 1, value: 1, interpolation: "hold" }, { path: "drawProgress", time: 0, value: 0 }] },
		])));
		let box = find(editor, "box");
		expect(keys(box, "opacity")).toEqual([[0, 0, "linear"], [1, 1, "step"]]);
		expect(keys(box, "params.drawProgress")).toEqual([[0, 0, "linear"]]);

		await withAgentApi(() => applyDraft(draft([{ op: "set", match: { agentId: "box" }, keyframes: [{ path: "opacity", time: 1, value: 0.5 }, { path: "scale", time: 2, value: 2 }] }])));
		box = find(editor, "box");
		expect(keys(box, "opacity").map((k: any[]) => k.slice(0, 2))).toEqual([[0, 0], [1, 0.5]]);
		expect(keys(box, "transform.scaleX")).toEqual([[2, 1, "linear"]]);

		await withAgentApi(() => applyDraft(draft([{ op: "set", match: { agentId: "box" }, keyframesMode: "replace", keyframes: [{ path: "opacity", time: 3, value: 0.2 }] }])));
		box = find(editor, "box");
		expect(Object.keys(box?.animations ?? {})).toEqual(["opacity"]);
		expect(keys(box, "opacity").map((k: any[]) => k.slice(0, 2))).toEqual([[3, 0.2]]);
		// Three drafts, three undo steps.
		editor.command.undo();
		editor.command.undo();
		editor.command.undo();
		expect(find(editor, "box")?.animations).toBeUndefined();
	});

	test("an unknown keyframe path fails the op and changes nothing", async () => {
		const editor = setup();
		const result = await withAgentApi(() => applyDraft(draft([{ op: "set", match: { agentId: "box" }, start: 1, keyframes: [{ path: "nonsense", time: 0, value: 1 }] }])));
		expect(result.results[0].ok).toBe(false);
		expect(find(editor, "box")?.startTime).toBe(T(0));
	});

	test("add and compound elements reuse project media by mediaId (nothing imported)", async () => {
		const editor = setup();
		const count = editor.media.getAssets().length;
		const result = await withAgentApi(() => applyDraft(draft([
			{ op: "add", track: { name: "Footage" }, element: { agent_id: "b", name: "B", mediaId: "clip-b", start: 10, duration: 2, trimStart: 1 } },
			{ op: "compound", agent_id: "c", name: "C", start: 12, track: { name: "Clips" }, elements: [{ agent_id: "c-logo", name: "Logo", mediaId: "logo-a", start: 0, duration: 1, size: [200, 100], track: { name: "Logos" } }] },
		])));
		expect(result.results.map((r: any) => r.ok)).toEqual([true, true]);
		expect(editor.media.getAssets().length).toBe(count);
		const b = find(editor, "b") as any;
		expect(b.mediaId).toBe("clip-b");
		expect(b.type).toBe("video");
		expect(b.trimStart).toBe(T(1));
		expect(b.trimEnd).toBe(T(3));
	});
});

describe("readiness", () => {
	test("ready only once the project's media are loaded and nothing is left to save", async () => {
		EditorCore.reset();
		const editor = EditorCore.getInstance();
		const scenes = timeline();
		const stored: TProject = {
			metadata: { id: "p", name: "p", thumbnail: "t", createdAt: new Date(0), updatedAt: new Date(0) }, scenes, currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as unknown as TProject;
		let releaseMedia!: () => void;
		const mediaGate = new Promise<void>((resolve) => { releaseMedia = resolve; });
		let releaseSave!: () => void;
		const saves: Promise<void>[] = [];
		const stubs = {
			ensureMigrations: async () => {},
			loadProject: async () => ({ project: structuredClone(stored) }),
			loadAllMediaAssets: async () => { await mediaGate; return [asset("m-1")]; },
			saveProject: () => { const p = new Promise<void>((resolve) => { releaseSave = resolve; }); saves.push(p); return p; },
		};
		Object.assign(storageService, stubs);
		try {
			const loading = editor.project.loadProject({ id: "p" });
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(agentReadiness()).toMatchObject({ ready: false, mediaLoaded: false });
			releaseMedia();
			await loading;
			expect(agentReadiness()).toMatchObject({ ready: true, mediaLoaded: true, pendingSave: false });

			editor.save.start();
			editor.timeline.deleteElements({ elements: [{ trackId: "t-main", elementId: "v1" }] });
			expect(agentReadiness()).toMatchObject({ ready: false, pendingSave: true });
			const settled = editor.save.settle();
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(saves.length).toBe(1);
			expect(agentReadiness().ready).toBe(false);
			releaseSave();
			expect(await settled).toBe(true);
			expect(agentReadiness()).toMatchObject({ ready: true, pendingSave: false, saveError: null });
			expect(agentReadiness().savedAt).not.toBe(new Date(0).toISOString());
		} finally {
			for (const key of Object.keys(stubs)) delete (storageService as any)[key];
		}
	});
});
