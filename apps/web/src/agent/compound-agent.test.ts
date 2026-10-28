import { afterEach, describe, expect, mock, test } from "bun:test";
import type { CompoundElement, GraphicElement, SceneTracks, TScene, TextElement, TimelineElement, VideoElement } from "@/timeline";
import type { TProject } from "@/project/types";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";
import { resolveMatch, toRootInterval } from "./scene-graph";
import { buildEditItems, buildSceneSnapshot } from "./snapshot";
import { createEditLogger, diffEdits, type EditItem } from "./edit-log";

// Stub the GPU modules (unused here) before EditorCore pulls them in; see scene-history.test.ts.
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { EditorCore } = await import("@/core");
const { applyDraft } = await import("./bridge");
const { computeAgentDraft } = await import("./draft");
const { AgentDraftCommand } = await import("./draft-command");
const { buildBundleScenes } = await import("./importer");

const T = (seconds: number) => Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const el = (type: string, id: string, start: number, duration: number, extra: Record<string, unknown> = {}) =>
	({ id, type, name: id, startTime: T(start), duration: T(duration), trimStart: T(0), trimEnd: T(0), params: {}, ...extra }) as unknown as TimelineElement;
const clip = (id: string, sceneId: string, start: number, trimStart: number, duration: number, source: number) =>
	({ ...el("compound", id, start, duration), sceneId, trimStart: T(trimStart), trimEnd: T(source - trimStart - duration), sourceDuration: T(source), params: { volume: -3, muted: false } }) as unknown as CompoundElement;
const main = (elements: TimelineElement[] = [], id = "t-main"): SceneTracks["main"] => ({ id, name: "Main", type: "video", muted: false, hidden: false, elements: elements as VideoElement[] });
const scene = (id: string, tracks: SceneTracks, kind?: "compound"): TScene => ({ id, name: id, isMain: id === "main", kind, tracks, bookmarks: [], createdAt: new Date(0), updatedAt: new Date(0) });

/**
 * main: bg video 0–20 s, clip c1 at 10 s showing s1 [2, 7).
 * s1:   title "a1" 6–9 s (agentId label), clip c2 at 1 s showing s2 [3, 7).
 * s2:   rect "r" 4–9 s (agentId label), rect "gone" 0–3 s (trimmed out by c2).
 */
function nested(): TScene[] {
	return [
		scene("main", { overlay: [{ id: "t-c1", name: "Clips", type: "video", muted: false, hidden: false, elements: [clip("c1", "s1", 10, 2, 5, 9)] }], main: main([el("video", "bg", 0, 20, { mediaId: "m-bg" })]), audio: [] }),
		scene("s1", {
			overlay: [
				{ id: "t-a1", name: "Text", type: "text", hidden: false, elements: [el("text", "a1", 6, 3, { agentId: "label", params: { content: "a1" } }) as TextElement] },
				{ id: "t-c2", name: "Inner", type: "video", muted: false, hidden: false, elements: [clip("c2", "s2", 1, 3, 4, 9)] },
			],
			main: main([], "t-main-s1"), audio: [],
		}, "compound"),
		scene("s2", {
			overlay: [{ id: "t-r", name: "Shapes", type: "graphic", hidden: false, elements: [el("graphic", "r", 4, 5, { agentId: "label", definitionId: "rectangle" }), el("graphic", "gone", 0, 3, { definitionId: "rectangle" })] as GraphicElement[] }],
			main: main([], "t-main-s2"), audio: [],
		}, "compound"),
	];
}

function setup(scenes: TScene[] = nested()) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	editor.save.pause();
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) }, scenes, currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	return editor;
}
const sceneOf = (editor: ReturnType<typeof setup>, id: string) => editor.scenes.getScenes().find((s) => s.id === id) as TScene;
const elementsOf = (s: TScene) => [...s.tracks.overlay, s.tracks.main, ...s.tracks.audio].flatMap((track): TimelineElement[] => track.elements);
const find = (editor: ReturnType<typeof setup>, sceneId: string, id: string) => elementsOf(sceneOf(editor, sceneId)).find((e) => e.id === id || e.agentId === id);
const draft = (ops: unknown[]) => ({ schema: "opencut-agent-draft-1", rev: "r", ops }) as Parameters<typeof applyDraft>[0];
const state = (editor: ReturnType<typeof setup>) => JSON.stringify(editor.scenes.getScenes().map((s) => ({ id: s.id, kind: s.kind, tracks: s.tracks })));

afterEach(() => EditorCore.reset());

describe("addressing and absolute times", () => {
	test("intervals map through two nesting levels and their trim windows", () => {
		const [, s1, s2] = nested();
		const c1 = nested()[0].tracks.overlay[0].elements[0] as CompoundElement;
		const c2 = s1.tracks.overlay[1].elements[0] as CompoundElement;
		expect(s2.id).toBe("s2");
		// [4, 9) in s2 → c2 window [3, 7) → s1 [2, 5) → c1 window [2, 7) → root [10, 13)
		expect(toRootInterval(T(4), T(9), [c1, c2])).toEqual([T(10), T(13)]);
		expect(toRootInterval(T(6), T(8), [c1, c2])).toEqual([T(12), T(13)]);
		expect(toRootInterval(T(0), T(3), [c1, c2])).toBeNull(); // trimmed out by the inner clip
		expect(toRootInterval(T(0), T(1.5), [c1])).toBeNull(); // trimmed out by the outer clip
		expect(toRootInterval(T(6), T(9), [c1])).toEqual([T(14), T(15)]);
	});

	test("snapshot keeps root tracks and adds every compound with paths, offsets and visible intervals", () => {
		const view = buildSceneSnapshot({ scenes: nested(), rootSceneId: "main", mediaName: new Map([["m-bg", "bg.mp4"]]) });
		const rootClip = view.tracks[0].elements[0];
		expect(rootClip).toMatchObject({ id: "c1", path: [], visible: [{ start: 10, end: 15, path: [] }], compound: { sceneId: "s1", kind: "compound", volume: -3, muted: false, sourceDuration: 9 } });
		expect(view.tracks[1].elements[0]).toMatchObject({ id: "bg", media: "bg.mp4", sceneId: "main" });
		expect(view.compounds.map((c) => [c.sceneId, c.path, c.kind])).toEqual([["s1", ["c1"], "compound"], ["s2", ["c1", "c2"], "compound"]]);
		const [s1, s2] = view.compounds;
		expect(s1.instances).toEqual([{ path: ["c1"], compoundId: "c1", agentId: null, offset: 8, visible: [{ start: 10, end: 15 }] }]);
		expect(s2.instances).toEqual([{ path: ["c1", "c2"], compoundId: "c2", agentId: null, offset: 6, visible: [{ start: 10, end: 13 }] }]);
		const r = s2.tracks[0].elements.find((e) => e.id === "r");
		expect(r).toMatchObject({ sceneId: "s2", path: ["c1", "c2"], start: 4, end: 9, visible: [{ start: 10, end: 13, path: ["c1", "c2"] }] });
		expect(s2.tracks[0].elements.find((e) => e.id === "gone")?.visible).toEqual([]);
		expect(s1.tracks[0].elements[0]).toMatchObject({ id: "a1", start: 6, end: 9, visible: [{ start: 14, end: 15, path: ["c1"] }] });
	});

	test("agentId across scenes is ambiguous until sceneId or path narrows it", () => {
		const scenes = nested();
		const err = resolveMatch(scenes, "main", { agentId: "label" });
		expect("error" in err && err.error).toContain("ambiguous");
		const pick = (match: unknown) => {
			const r = resolveMatch(scenes, "main", match);
			return "hit" in r ? [r.hit.sceneId, r.hit.element.id] : r.error;
		};
		expect(pick({ agentId: "label", sceneId: "s2" })).toEqual(["s2", "r"]);
		expect(pick({ agentId: "label", path: ["c1", "c2"] })).toEqual(["s2", "r"]);
		expect(pick({ agentId: "label", path: ["c1"] })).toEqual(["s1", "a1"]);
		expect(pick({ id: "r" })).toEqual(["s2", "r"]);
		expect(pick({ agentId: "nope" })).toContain("not found");
		expect(pick({ id: "r", path: ["bg"] })).toContain("not a compound clip");
	});
});

describe("draft ops inside compounds", () => {
	test("one draft touching three scenes is one undo; redo restores it and its selection", async () => {
		const editor = setup();
		const original = state(editor);
		await applyDraft(draft([
			{ op: "set", match: { agentId: "label", path: ["c1", "c2"] }, start: 5, params: { "transform.positionX": 50 } },
			{ op: "add", track: { name: "Titles", compound: { id: "c1" } }, element: { agent_id: "t2", name: "T2", text: "Hi", start: 0.5, duration: 1 } },
			{ op: "set", match: { id: "bg" }, params: { opacity: 0.5 } },
		]));
		expect(find(editor, "s2", "r")).toMatchObject({ startTime: T(5), params: { "transform.positionX": 50 } });
		const titles = sceneOf(editor, "s1").tracks.overlay.find((t) => t.name === "Titles");
		expect(titles?.elements.map((e) => [e.agentId, e.startTime])).toEqual([["t2", T(0.5)]]);
		expect(find(editor, "main", "bg")?.params.opacity).toBe(0.5);
		const applied = state(editor);
		const selected = [{ trackId: "t-c1", elementId: "c1" }, { trackId: "t-main", elementId: "bg" }];
		expect(editor.selection.getSelectedElements()).toEqual(selected);

		editor.command.undo();
		expect(state(editor)).toBe(original);
		expect(editor.command.canUndo()).toBe(false);
		expect(editor.selection.getSelectedElements()).toEqual([]);

		// Redo from inside a compound: history goes back to the root and selects the same items.
		await editor.scenes.switchToScene({ sceneId: "s1" });
		editor.command.redo();
		expect(editor.scenes.getActiveScene().id).toBe("main");
		expect(state(editor)).toBe(applied);
		expect(editor.selection.getSelectedElements()).toEqual(selected);
	});

	test("an undo whose scene vanished outside history is refused and history is kept", async () => {
		const editor = setup();
		await applyDraft(draft([{ op: "set", match: { id: "r" }, start: 4.5 }]));
		const before = state(editor);
		// The nested scene disappears outside history (e.g. a project sync).
		editor.scenes.setScenes({ scenes: editor.scenes.getScenes().filter((s) => s.id !== "s2") });
		const missing = state(editor);
		expect(missing).not.toBe(before);
		editor.command.undo();
		expect(state(editor)).toBe(missing);
		expect(editor.command.canUndo()).toBe(true);
	});

	test("group, then ungroup, report addresses and keep paths consistent", async () => {
		const editor = setup();
		const fetchMock = mock(async (_url: string, init?: { body?: string }) => ({ ok: true, json: async () => ({}), body: init?.body }));
		const realFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			await applyDraft(draft([{ op: "group", agent_id: "g1", name: "Group", match: [{ id: "bg" }, { id: "c1" }] }]));
			const result = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body ?? "{}").results[0];
			expect(result).toMatchObject({ op: "group", ok: true, agentId: "g1", compound: { sceneId: "main", agentId: "g1" } });
			const g1 = find(editor, "main", "g1") as CompoundElement;
			expect(result.sceneId).toBe(g1.sceneId);
			expect(result.elements.map((a: { id: string; path: string[] }) => [a.id, a.path])).toEqual([["bg", [g1.id]], ["c1", [g1.id]]]);
			// The deeper element now has a longer path, and edits still find it by agentId + path.
			await applyDraft(draft([{ op: "set", match: { agentId: "label", path: ["g1", "c1", "c2"] }, params: { opacity: 0.2 } }]));
			expect(find(editor, "s2", "r")?.params.opacity).toBe(0.2);
			const r = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body ?? "{}").results[0];
			expect(r.element).toMatchObject({ sceneId: "s2", id: "r", path: [g1.id, "c1", "c2"] });

			await applyDraft(draft([{ op: "ungroup", match: { agentId: "g1" } }]));
			const un = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body ?? "{}").results[0];
			expect(un.ok).toBe(true);
			expect(un.elements.map((a: { sceneId: string; path: string[] }) => [a.sceneId, a.path])).toEqual([["main", []], ["main", []]]);
			expect(find(editor, "main", "c1")?.type).toBe("compound");
			expect(find(editor, "main", "g1")).toBeUndefined();

			await applyDraft(draft([{ op: "group", match: [{ id: "bg" }, { id: "r" }] }]));
			const bad = JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body ?? "{}").results[0];
			expect(bad).toMatchObject({ ok: false, error: "group: all elements must be in the same scene" });
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("compound op builds a mograph scene in one step, with keyframes and audio, on an unmuted video track", () => {
		const scenes = nested();
		const whoosh = { path: "sfx/whoosh.wav", type: "audio" as const, name: "whoosh" };
		const ops = [{
			op: "compound", agent_id: "mg", name: "Mograph", start: 2, track: { name: "Mograph" },
			elements: [
				{ agent_id: "box1", name: "Box", graphic: { definitionId: "rectangle" }, start: 0, duration: 3, track: { name: "Shapes" } },
				{ agent_id: "arrow1", name: "Arrow", graphic: { definitionId: "arrow" }, start: 0.5, duration: 2.5, track: { name: "Arrows" }, keyframes: [{ path: "drawProgress", time: 0, value: 0 }, { path: "drawProgress", time: 1, value: 1 }] },
				{ agent_id: "sfx", name: "Whoosh", asset: whoosh, start: 0.4, duration: 1, track: { name: "SFX" } },
			],
		}] as Parameters<typeof computeAgentDraft>[0]["ops"];
		const audio = ops[0].op === "compound" ? ops[0].elements?.[2] : undefined;
		const out = computeAgentDraft({
			scenes, rootSceneId: "main", ops, canvas: { width: 1920, height: 1080 }, fps: { numerator: 30, denominator: 1 }, ripple: false,
			mediaFor: (e) => (e === audio ? { id: "m-whoosh", type: "audio", duration: 1 } : undefined),
		});
		expect(out.results[0]).toMatchObject({ op: "compound", ok: true, agentId: "mg", compound: { sceneId: "main", agentId: "mg", path: [] } });
		const host = out.scenes.find((s) => s.id === "main") as TScene;
		const track = host.tracks.overlay.find((t) => t.name === "Mograph");
		expect(track).toMatchObject({ type: "video", muted: false });
		const mg = track?.elements[0] as CompoundElement;
		expect(mg).toMatchObject({ type: "compound", agentId: "mg", startTime: T(2), duration: T(3), trimStart: 0, sourceDuration: T(3) });
		const content = out.scenes.find((s) => s.id === mg.sceneId) as TScene;
		expect(content.kind).toBe("compound");
		// Each new track goes on top, like a draft add: listed elements paint bottom to top.
		expect(content.tracks.overlay.map((t) => t.name)).toEqual(["Arrows", "Shapes"]);
		expect(content.tracks.audio.map((t) => [t.name, t.elements[0].agentId])).toEqual([["SFX", "sfx"]]);
		const arrow = elementsOf(content).find((e) => e.agentId === "arrow1");
		expect(JSON.stringify(arrow?.animations)).toContain("drawProgress");
		expect(out.results[0].elements.map((a: { agentId: string; path: string[] }) => [a.agentId, a.path])).toEqual([["arrow1", [mg.id]], ["box1", [mg.id]], ["sfx", [mg.id]]]);
		expect(out.touched).toEqual([{ sceneId: "main", elementId: mg.id }]);
	});

	test("failed ops change nothing and old drafts keep working", async () => {
		const editor = setup();
		const original = state(editor);
		await applyDraft(draft([
			{ op: "set", match: { agentId: "label" }, start: 1 }, // ambiguous
			{ op: "add", track: { name: "X", compound: { id: "bg" } }, element: { name: "x", text: "x", start: 0, duration: 1 } }, // not a compound
			{ op: "compound", name: "Empty", start: 0, track: { name: "Y" }, elements: [] },
			{ op: "ungroup", match: { id: "bg" } },
		]));
		expect(state(editor)).toBe(original);
		expect(editor.command.canUndo()).toBe(false);
		// The pre-compound format: plain match and add on the root.
		await applyDraft(draft([{ op: "add", track: { name: "Captions", type: "text" }, element: { agent_id: "cap", name: "cap", text: "hey", start: 1, duration: 2 } }, { op: "set", match: { agentId: "cap" }, duration: 3 }]));
		expect(find(editor, "main", "cap")).toMatchObject({ duration: T(3) });
	});
});

describe("edit log inside compounds", () => {
	const item = (over: Partial<EditItem>): EditItem => ({ id: "r", agentId: "label", name: "r", media: null, type: "graphic", track: "Shapes", sceneId: "s2", path: ["c1", "c2"], startTime: 4, duration: 5, trimStart: 0, trimEnd: 0, params: {}, animations: {}, ...over });

	test("lines carry sceneId and path; grouping is one sceneId change, not delete + add", () => {
		const lines = diffEdits({ projectId: "p", items: [item({})] }, { projectId: "p", items: [item({ startTime: 5 })] });
		expect(lines.map((l) => [l.field, l.sceneId, l.path])).toEqual([["startTime", "s2", ["c1", "c2"]]]);
		const moved = diffEdits({ projectId: "p", items: [item({ sceneId: "main", path: [], track: "Shapes" })] }, { projectId: "p", items: [item({ sceneId: "g", path: ["g1"] })] });
		expect(moved.map((l) => [l.kind, l.field, l.from, l.to])).toEqual([["set", "sceneId", "main", "g"]]);
		const items = buildEditItems({ scenes: nested(), rootSceneId: "main", mediaName: new Map() });
		expect(items.find((i) => i.id === "r")).toMatchObject({ sceneId: "s2", path: ["c1", "c2"], startTime: 4 });
	});

	test("human edits inside a nested scene are logged with their address; agent drafts there are not", async () => {
		const editor = setup();
		const sent: { field: string; sceneId: string; path: string[] }[] = [];
		const capture = () => ({ projectId: "p", items: buildEditItems({ scenes: editor.scenes.getScenes(), rootSceneId: "main", mediaName: new Map() }) });
		const logger = createEditLogger(capture, () => false, (lines) => sent.push(...lines));
		const wait = () => new Promise((resolve) => setTimeout(resolve, 900));

		const out = computeAgentDraft({ scenes: editor.scenes.getScenes(), rootSceneId: "main", ops: [{ op: "set", match: { id: "r" }, params: { opacity: 0.3 } }], canvas: { width: 1920, height: 1080 }, fps: { numerator: 30, denominator: 1 }, ripple: false, mediaFor: () => undefined });
		editor.command.execute({ command: new AgentDraftCommand({ before: editor.scenes.getScenes(), after: out.scenes, selection: [], wrap: (action) => logger.agent(() => { action(); logger.changed(); }) }) });
		await wait();
		expect(sent).toEqual([]);

		await editor.scenes.switchToScene({ sceneId: "s2" });
		const tracks = editor.scenes.getActiveScene().tracks;
		editor.timeline.updateTracks({ ...tracks, overlay: tracks.overlay.map((t) => ({ ...t, elements: t.elements.map((e) => (e.id === "r" ? { ...e, startTime: T(6) } : e)) })) as SceneTracks["overlay"] });
		logger.changed();
		await wait();
		expect(sent.map((l) => [l.field, l.sceneId, l.path])).toEqual([["startTime", "s2", ["c1", "c2"]]]);
	});
});

describe("bundle compounds", () => {
	test("a bundle element with compound content becomes a clip with nested tracks, keyframes, and nested clips", () => {
		const built = buildBundleScenes({
			sceneId: "main", media: new Map(),
			bundle: {
				name: "b", width: 1920, height: 1080, assets: [], main: [], audio: [],
				overlay: [{
					name: "MG", type: "video", elements: [{
						agent_id: "mg", name: "MG", start: 1, duration: undefined as unknown as number,
						compound: {
							overlay: [{ name: "Shapes", type: "graphic", elements: [{ agent_id: "b", name: "b", graphic: { definitionId: "rectangle" }, start: 0, duration: 2, keyframes: [{ path: "opacity", time: 0, value: 0 }, { path: "opacity", time: 1, value: 1 }] }] }],
							elements: [{ agent_id: "inner", name: "inner", start: 0.5, duration: 1, track: { name: "Inner" }, compound: { elements: [{ agent_id: "t", name: "t", text: "x", start: 0, duration: 1, track: { name: "T" } }] } }],
						},
					}],
				}],
			},
		});
		const track = built.tracks.overlay[0];
		expect(track).toMatchObject({ name: "MG", type: "video", muted: false });
		const mg = track.elements[0] as CompoundElement;
		expect(mg).toMatchObject({ agentId: "mg", startTime: T(1), duration: T(2), sourceDuration: T(2) });
		expect(built.scenes.map((s) => s.kind)).toEqual(["compound", "compound"]);
		const content = built.scenes.find((s) => s.id === mg.sceneId) as TScene;
		expect(content.tracks.overlay.map((t) => [t.name, t.type])).toEqual([["Inner", "video"], ["Shapes", "graphic"]]);
		expect(JSON.stringify(elementsOf(content).find((e) => e.agentId === "b")?.animations)).toContain("opacity");
		const inner = elementsOf(content).find((e) => e.agentId === "inner") as CompoundElement;
		expect(elementsOf(built.scenes.find((s) => s.id === inner.sceneId) as TScene).map((e) => e.agentId)).toEqual(["t"]);
	});
});

describe("round 2 regressions", () => {
	test("ungrouping the open compound: Undo and Redo restore the scene, playhead, and selection", async () => {
		const editor = setup();
		editor.playback.seek({ time: T(8) });
		await editor.scenes.switchToScene({ sceneId: "s1" });
		editor.playback.seek({ time: T(2) });
		const a1 = { trackId: "t-a1", elementId: "a1" };
		editor.selection.setSelectedElements({ elements: [a1] });

		await applyDraft(draft([{ op: "ungroup", match: { id: "c1" } }]));
		expect(editor.scenes.getScenes().some((s) => s.id === "s1")).toBe(false);
		expect(editor.scenes.getActiveScene().id).toBe("main");
		expect(editor.playback.getCurrentTime()).toBe(T(8));
		const restored = editor.selection.getSelectedElements();
		expect(restored.length).toBeGreaterThan(0);
		const mainIds = elementsOf(sceneOf(editor, "main")).map((e) => e.id);
		expect(restored.every((ref) => mainIds.includes(ref.elementId))).toBe(true);
		const ungrouped = state(editor);

		editor.command.undo();
		expect(editor.scenes.getScenes().some((s) => s.id === "s1")).toBe(true);
		expect(editor.scenes.getActiveScene().id).toBe("s1");
		expect(editor.playback.getCurrentTime()).toBe(T(2));
		expect(editor.selection.getSelectedElements()).toEqual([a1]);
		expect(editor.command.canRedo()).toBe(true);
		expect(editor.command.canUndo()).toBe(false);

		editor.command.redo();
		expect(state(editor)).toBe(ungrouped);
		expect(editor.scenes.getActiveScene().id).toBe("main");
		expect(editor.playback.getCurrentTime()).toBe(T(8));
		expect(editor.selection.getSelectedElements()).toEqual(restored);
		editor.command.undo();
		expect(editor.scenes.getActiveScene().id).toBe("s1");
	});

	test("grouping and ungrouping at non-zero times log only the scene change, not remapped times or tracks", async () => {
		const editor = setup();
		const sent: { field: string; elementId: string; from: unknown; to: unknown }[] = [];
		const capture = () => ({ projectId: "p", items: buildEditItems({ scenes: editor.scenes.getScenes(), rootSceneId: "main", mediaName: new Map() }) });
		const logger = createEditLogger(capture, () => false, (lines) => sent.push(...lines));
		const settle = async () => { logger.changed(); await new Promise((resolve) => setTimeout(resolve, 900)); };

		// c1 starts at 10 s: inside the new compound its own start becomes 0.
		const { compound } = editor.timeline.createCompound({ elements: [{ trackId: "t-c1", elementId: "c1" }] });
		await settle();
		expect(sent.map((l) => [l.elementId, l.field])).toEqual([["c1", "sceneId"]]);
		sent.length = 0;
		editor.timeline.ungroupCompound(compound);
		await settle();
		expect(sent.map((l) => [l.elementId, l.field])).toEqual([["c1", "sceneId"]]);
		sent.length = 0;
		// The main-track element goes to the nested "Main Track": no track line either.
		editor.timeline.createCompound({ elements: [{ trackId: "t-main", elementId: "bg" }] });
		await settle();
		expect(sent.map((l) => [l.elementId, l.field])).toEqual([["bg", "sceneId"]]);
		sent.length = 0;
		// A real edit is still logged.
		const host = editor.scenes.getActiveScene();
		const track = host.tracks.overlay.find((t) => t.elements.some((e) => e.id === "c1"));
		editor.timeline.updateElements({ updates: [{ trackId: track?.id ?? "", elementId: "c1", patch: { startTime: T(11) } }] });
		await settle();
		expect(sent.map((l) => [l.elementId, l.field, l.from, l.to])).toEqual([["c1", "startTime", 10, 11]]);
	});

	test("id wins across all scenes before agentId is tried", () => {
		const r = resolveMatch(nested(), "main", { id: "bg", agentId: "label" });
		expect("hit" in r && [r.hit.sceneId, r.hit.element.id]).toEqual(["main", "bg"]);
	});

	test("Main reaches the main track of a UI-created compound (named Main Track)", () => {
		const editor = setup();
		const { compound, sceneId } = editor.timeline.createCompound({ elements: [{ trackId: "t-c1", elementId: "c1" }] });
		const nestedScene = sceneOf(editor, sceneId);
		expect(nestedScene.tracks.main.name).toBe("Main Track");
		const element = { agent_id: "clip", name: "clip", asset: { path: "a.mp4", type: "video" as const, name: "a" }, start: 0, duration: 2 };
		const out = computeAgentDraft({
			scenes: editor.scenes.getScenes(), rootSceneId: "main", canvas: { width: 1920, height: 1080 }, fps: { numerator: 30, denominator: 1 }, ripple: false,
			ops: [{ op: "add", track: { name: "Main", type: "video", compound: { id: compound.elementId } }, element }],
			mediaFor: () => ({ id: "m-a", type: "video", width: 1920, height: 1080, duration: 4 }),
		});
		expect(out.results[0]).toMatchObject({ ok: true });
		const after = out.scenes.find((s) => s.id === sceneId) as TScene;
		expect(after.tracks.overlay.length).toBe(nestedScene.tracks.overlay.length);
		expect(after.tracks.main.elements.map((e) => e.agentId)).toEqual(["clip"]);
		// Agent-built compounds use the same default main track name.
		const built = computeAgentDraft({
			scenes: editor.scenes.getScenes(), rootSceneId: "main", canvas: { width: 1920, height: 1080 }, fps: { numerator: 30, denominator: 1 }, ripple: false,
			ops: [{ op: "compound", name: "C", start: 0, main: [element] }], mediaFor: () => ({ id: "m-a", type: "video", width: 1920, height: 1080, duration: 4 }),
		});
		const content = built.scenes.find((s) => s.id === built.results[0].sceneId) as TScene;
		expect(content.tracks.main.name).toBe("Main Track");
		expect(content.tracks.main.elements.map((e) => e.agentId)).toEqual(["clip"]);
	});

	test("deeply shared nesting stays bounded: capped instances, fast snapshot and edit capture", () => {
		// 14 levels of split compounds: every scene shows the next one twice (15 scenes, 28 clips).
		const levels = 14;
		const scenes: TScene[] = [];
		for (let level = 0; level <= levels; level++) {
			const id = level === 0 ? "main" : `L${level}`;
			const clips = level < levels ? [clip(`c${level}a`, `L${level + 1}`, 0, 0, 1, 2), clip(`c${level}b`, `L${level + 1}`, 1, 1, 1, 2)] : [];
			const leaf = level === levels ? [el("text", "leaf", 0, 2, { agentId: "leaf", params: { content: "x" } }) as TextElement] : [];
			scenes.push(scene(id, {
				overlay: [{ id: `t${level}`, name: "Clips", type: "video", muted: false, hidden: false, elements: clips }, { id: `x${level}`, name: "Text", type: "text", hidden: false, elements: leaf }],
				main: main([], `m${level}`), audio: [],
			}, level === 0 ? undefined : "compound"));
		}
		let started = performance.now();
		const view = buildSceneSnapshot({ scenes, rootSceneId: "main", mediaName: new Map() });
		const snapshotMs = performance.now() - started;
		const deepest = view.compounds.find((c) => c.sceneId === `L${levels}`);
		expect(view.compounds.length).toBe(levels);
		expect(deepest?.instances.length).toBeLessThanOrEqual(32);
		expect(deepest?.truncated).toBe(true);
		expect(deepest?.path).toEqual(Array.from({ length: levels }, (_, i) => `c${i}a`));
		started = performance.now();
		const items = buildEditItems({ scenes, rootSceneId: "main", mediaName: new Map() });
		const captureMs = performance.now() - started;
		expect(items.find((i) => i.id === "leaf")?.path).toEqual(deepest?.path);
		const hit = resolveMatch(scenes, "main", { agentId: "leaf" });
		expect("hit" in hit && hit.hit.sceneId).toBe(`L${levels}`);
		expect(snapshotMs).toBeLessThan(150);
		expect(captureMs).toBeLessThan(50);
	});
});
