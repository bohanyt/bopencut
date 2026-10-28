import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TScene, TextElement } from "@/timeline";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";
import { allElements, allTracks, fixture, getHost, refs, t, video } from "./compound-fixtures";

// Another test file replaces opencut-wasm with a partial mock and Bun keeps that module shape,
// so stub the GPU modules (unused here) before EditorCore pulls them in.
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const { BatchCommand } = await import("@/commands");
const { RemoveMediaAssetCommand } = await import("@/commands/media");
const { applyDraft } = await import("@/agent/bridge");
const { CreateCompoundCommand, DeleteElementsCommand, InsertElementCommand } = await import(
	"@/commands/timeline"
);

// History is scene-bound: undo/redo first switch the editor to the scene the command ran in.

function setup(scenes: TScene[] = fixture()) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	// No autosave from these tests (it would write to storage after the test ends).
	editor.save.stop();
	editor.save.pause();
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	return editor;
}

function title(name: string, start: number): InstanceType<typeof InsertElementCommand> {
	return new InsertElementCommand({
		element: {
			type: "text",
			name,
			startTime: t(start),
			duration: t(1),
			trimStart: t(0),
			trimEnd: t(0),
			params: { content: name },
		},
		placement: { mode: "auto" },
	});
}

function elementsIn(editor: ReturnType<typeof setup>, sceneId: string) {
	const scene = editor.scenes.getScenes().find((s) => s.id === sceneId);
	return scene ? allElements(allTracks(scene.tracks)) : [];
}

afterEach(() => {
	EditorCore.reset();
});

describe("scene-bound history", () => {
	test("redo of a scene creation keeps its id, so a title inserted there comes back there", async () => {
		const editor = setup();
		const sceneId = await editor.scenes.createScene({ name: "A", isMain: false });
		const mainTrackId = editor.scenes.getScenes().find((s) => s.id === sceneId)?.tracks.main.id;
		await editor.scenes.switchToScene({ sceneId });
		const insert = title("hello", 0);
		editor.command.execute({ command: insert });
		expect(elementsIn(editor, sceneId).map((e) => e.name)).toEqual(["hello"]);

		editor.command.undo(); // the title, in A
		editor.command.undo(); // the scene, recorded in main → switches to main
		expect(editor.scenes.getScenes().some((s) => s.id === sceneId)).toBe(false);
		expect(editor.scenes.getActiveScene().id).toBe("main");

		editor.command.redo();
		expect(editor.scenes.getScenes().find((s) => s.id === sceneId)?.tracks.main.id).toBe(mainTrackId);
		editor.command.redo(); // recorded in A → switches to A
		expect(editor.scenes.getActiveScene().id).toBe(sceneId);
		expect(elementsIn(editor, sceneId).map((e) => e.name)).toEqual(["hello"]);
		expect(elementsIn(editor, "main").some((e) => e.name === "hello")).toBe(false);
	});

	test("a step whose scene no longer exists is refused and history is kept", async () => {
		const editor = setup();
		const sceneId = await editor.scenes.createScene({ name: "A", isMain: false });
		await editor.scenes.switchToScene({ sceneId });
		editor.command.execute({ command: title("hello", 0) });
		await editor.scenes.switchToScene({ sceneId: "main" });
		// The scene disappears outside history (e.g. a project sync).
		editor.scenes.setScenes({ scenes: editor.scenes.getScenes().filter((s) => s.id !== sceneId) });
		const mainBefore = editor.scenes.getActiveScene().tracks;

		editor.command.undo();
		expect(editor.scenes.getActiveScene().id).toBe("main");
		expect(editor.scenes.getActiveScene().tracks).toBe(mainBefore);
		expect(elementsIn(editor, "main").some((e) => e.name === "hello")).toBe(false);
		expect(editor.command.canUndo()).toBe(true);
		expect(editor.command.canRedo()).toBe(false);
	});

	test("undoing the deletion of the open scene still works: that command brings the scene back", async () => {
		const editor = setup();
		const sceneId = await editor.scenes.createScene({ name: "A", isMain: false });
		await editor.scenes.switchToScene({ sceneId });
		await editor.scenes.deleteScene({ sceneId });
		expect(editor.scenes.getScenes().some((s) => s.id === sceneId)).toBe(false);

		editor.command.undo();
		expect(editor.scenes.getScenes().some((s) => s.id === sceneId)).toBe(true);
	});

	test("undo in another scene shows it at its own playhead; the open scene keeps its playhead", async () => {
		const editor = setup();
		const { sceneId } = editor.timeline.createCompound({ elements: refs }); // nested scene is 4 s
		await editor.scenes.switchToScene({ sceneId });
		editor.playback.seek({ time: t(2) });
		editor.command.execute({ command: title("nested", 0) });
		await editor.scenes.switchToScene({ sceneId: "main" }); // main is 10 s
		editor.playback.seek({ time: t(8) });

		editor.command.undo();
		expect(editor.scenes.getActiveScene().id).toBe(sceneId);
		expect(editor.playback.getCurrentTime()).toBe(t(2));

		await editor.scenes.switchToScene({ sceneId: "main" });
		expect(editor.playback.getCurrentTime()).toBe(t(8));
	});

	test("redo from another scene applies the command's selection in that scene", async () => {
		const editor = setup();
		const { sceneId } = editor.timeline.createCompound({ elements: refs });
		await editor.scenes.switchToScene({ sceneId });
		const insert = title("nested", 0);
		editor.command.execute({ command: insert });
		const inserted = { trackId: insert.getTrackId() ?? "", elementId: insert.getElementId() };
		expect(editor.selection.getSelectedElements()).toEqual([inserted]);

		editor.command.undo();
		await editor.scenes.switchToScene({ sceneId: "main" });
		editor.command.redo();
		expect(editor.scenes.getActiveScene().id).toBe(sceneId);
		expect(editor.selection.getSelectedElements()).toEqual([inserted]);
		// The track the redo recreated is the same one the selection points at.
		expect(
			editor.scenes.getActiveScene().tracks.overlay.some((track) => track.id === inserted.trackId),
		).toBe(true);
	});
});

describe("commands that remove clips", () => {
	test("removing a media asset is one history entry, returns its selection, and cleans compound content", () => {
		const scenes = fixture();
		const host = getHost(scenes);
		host.tracks.overlay = [
			...host.tracks.overlay,
			{ id: "t-clips", name: "Clips", type: "video", muted: false, hidden: false, elements: [video("clip", 1, 2)] },
		];
		const editor = setup(scenes);
		(editor.media as unknown as { assets: MediaAsset[] }).assets = [
			{ id: "media-clip", name: "clip", type: "video", file: new File([], "clip.mp4") } as MediaAsset,
		];
		// Put the clip inside a compound so the asset is used in a nested scene.
		const { compound, sceneId } = editor.timeline.createCompound({
			elements: [{ trackId: "t-clips", elementId: "clip" }],
		});
		editor.selection.setSelectedElements({ elements: [compound] });

		editor.command.execute({
			command: new RemoveMediaAssetCommand({ projectId: "p", assetId: "media-clip" }),
		});
		expect(elementsIn(editor, sceneId).some((e) => e.id === "clip")).toBe(false);
		expect(editor.selection.getSelectedElements()).toEqual([]);

		editor.command.undo();
		expect(elementsIn(editor, sceneId).some((e) => e.id === "clip")).toBe(true);
		expect(editor.media.getAssets().map((asset) => asset.id)).toEqual(["media-clip"]);
		// One entry for the removal; the next undo is the compound creation.
		editor.command.undo();
		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual(["main"]);
		expect(editor.command.canUndo()).toBe(false);
	});

	test("ripple through nested and mixed batches leaves compound neighbours in place", () => {
		const scenes = fixture();
		const host = getHost(scenes);
		const textTrack = host.tracks.overlay.find((track) => track.id === "t-text");
		if (!textTrack || textTrack.type !== "text") throw new Error("fixture");
		textTrack.elements.push({ ...(textTrack.elements[0] as TextElement), id: "neighbour", startTime: t(10) });
		host.tracks.main.elements.push(video("after-bg", 10, 2));
		const editor = setup(scenes);
		editor.command.isRippleEnabled = true;

		// Grouping inside nested batches: the neighbour title must stay at 10 s.
		editor.command.execute({
			command: new BatchCommand([new BatchCommand([new CreateCompoundCommand({ elements: refs })])]),
		});
		const startOf = (id: string) => elementsIn(editor, "main").find((e) => e.id === id)?.startTime;
		expect(startOf("neighbour")).toBe(t(10));
		editor.command.undo();
		expect(startOf("neighbour")).toBe(t(10));

		// Mixed batch: the compound child stays exempt, the delete still ripples.
		editor.command.execute({
			command: new BatchCommand([
				new CreateCompoundCommand({ elements: refs }),
				new DeleteElementsCommand({ elements: [{ trackId: "t-main", elementId: "bg" }] }),
			]),
		});
		expect(startOf("neighbour")).toBe(t(10));
		expect(startOf("after-bg")).toBe(t(0));
	});

	test("an agent draft ripples once on apply, undo and redo", async () => {
		const run = async (clips: [string, number][], expected: [string, number][]) => {
			const scenes = fixture();
			const host = getHost(scenes);
			const textTrack = host.tracks.overlay.find((track) => track.id === "t-text");
			if (!textTrack || textTrack.type !== "text") throw new Error("fixture");
			const template = textTrack.elements[0] as TextElement;
			textTrack.elements = clips.map(([id, start]) => ({ ...template, id, startTime: t(start), duration: t(2) }));
			const editor = setup(scenes);
			editor.command.isRippleEnabled = true;
			const startsOf = () =>
				Object.fromEntries(
					(editor.scenes.getActiveScene().tracks.overlay.find((track) => track.id === "t-text")?.elements ?? []).map(
						(e) => [e.id, e.startTime],
					),
				);
			const original = startsOf();

			await applyDraft({ schema: "opencut-agent-draft-1", rev: "r", label: "r", ops: [{ op: "delete", match: { id: "A" } }] });
			expect(startsOf()).toEqual(Object.fromEntries(expected.map(([id, start]) => [id, t(start)])));
			editor.command.undo();
			expect(startsOf()).toEqual(original);
			editor.command.redo();
			expect(startsOf()).toEqual(Object.fromEntries(expected.map(([id, start]) => [id, t(start)])));
		};
		await run(
			[
				["A", 0],
				["B", 8],
			],
			[["B", 6]],
		);
		await run(
			[
				["A", 0],
				["B", 2],
				["C", 4],
				["D", 10],
			],
			[
				["B", 0],
				["C", 2],
				["D", 8],
			],
		);
	});
});

describe("scene transitions", () => {
	async function sceneWithTitle(editor: ReturnType<typeof setup>) {
		const sceneId = await editor.scenes.createScene({ name: "A", isMain: false });
		await editor.scenes.switchToScene({ sceneId });
		const insert = new InsertElementCommand({
			element: {
				type: "text",
				name: "four seconds",
				startTime: t(0),
				duration: t(4),
				trimStart: t(0),
				trimEnd: t(0),
				params: { content: "four seconds" },
			},
			placement: { mode: "auto" },
		});
		editor.command.execute({ command: insert });
		return { sceneId, title: { trackId: insert.getTrackId() ?? "", elementId: insert.getElementId() } };
	}

	test("deleting the open scene and undoing it go through the same transition as a switch", async () => {
		const editor = setup();
		await editor.scenes.switchToScene({ sceneId: "main" });
		const { sceneId, title: titleRef } = await sceneWithTitle(editor);
		await editor.scenes.switchToScene({ sceneId: "main" });
		editor.playback.seek({ time: t(8) });
		await editor.scenes.switchToScene({ sceneId });
		editor.playback.seek({ time: t(2) });
		editor.selection.setSelectedElements({ elements: [titleRef] });

		await editor.scenes.deleteScene({ sceneId });
		expect(editor.scenes.getActiveScene().id).toBe("main");
		expect(editor.playback.getCurrentTime()).toBe(t(8));
		expect(editor.selection.getSelectedElements()).toEqual([]);
		expect(editor.project.getActive().currentSceneId).toBe("main");

		editor.playback.seek({ time: t(9) });
		editor.command.undo();
		expect(editor.scenes.getActiveScene().id).toBe(sceneId);
		expect(editor.playback.getCurrentTime()).toBe(t(2));
		expect(editor.project.getActive().currentSceneId).toBe(sceneId);
		await editor.scenes.switchToScene({ sceneId: "main" });
		expect(editor.playback.getCurrentTime()).toBe(t(9));
	});

	test("a cross-scene undo while playing pauses at the restored playhead, never at a clamped time", async () => {
		const editor = setup();
		const { sceneId } = editor.timeline.createCompound({ elements: refs }); // nested scene is 4 s
		await editor.scenes.switchToScene({ sceneId });
		editor.playback.seek({ time: t(2) });
		editor.command.execute({ command: title("nested", 0) });
		await editor.scenes.switchToScene({ sceneId: "main" }); // main is 10 s
		editor.playback.seek({ time: t(8) });
		// Playing state without the frame clock (the clock is not under test).
		(editor.playback as unknown as { isPlaying: boolean }).isPlaying = true;
		expect(editor.playback.getIsPlaying()).toBe(true);

		const seeks: number[] = [];
		const stop = editor.playback.onSeek((time) => seeks.push(time));
		editor.command.undo();
		stop();
		expect(editor.scenes.getActiveScene().id).toBe(sceneId);
		expect(editor.playback.getCurrentTime()).toBe(t(2));
		expect(editor.playback.getIsPlaying()).toBe(false);
		expect(seeks).toEqual([t(2)]);
	});
});
