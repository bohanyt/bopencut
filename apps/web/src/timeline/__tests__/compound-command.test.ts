import { afterEach, describe, expect, mock, test } from "bun:test";
import type { CompoundElement, CreateCompoundElement, TScene } from "@/timeline";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";
import {
	allElements,
	allTracks,
	findCompound,
	fixture,
	getHost,
	layout,
	refs,
	t,
} from "./compound-fixtures";

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
const { DeleteSceneCommand } = await import("@/commands/scene");
const { InsertElementCommand, MoveElementCommand, UpdateElementsCommand } = await import(
	"@/commands/timeline"
);
const { CompoundCycleError, expandCompoundAudioTracks } = await import("@/timeline/compound");

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

function compoundClip(sceneId: string, start: number, duration: number): CreateCompoundElement {
	return {
		type: "compound",
		name: "clip",
		sceneId,
		startTime: t(start),
		duration: t(duration),
		trimStart: t(0),
		trimEnd: t(0),
		params: { volume: 0, muted: false },
	};
}

afterEach(() => {
	EditorCore.reset();
});

describe("compound clip commands", () => {
	test("editor API: one Undo reverts create, Redo replays it, ripple does not shift neighbours", () => {
		const original = fixture();
		const editor = setup(original);
		editor.command.isRippleEnabled = true;

		const { compound, sceneId } = editor.timeline.createCompound({ elements: refs });
		const afterCreate = editor.scenes.getScenes();
		expect(afterCreate.map((s) => s.id)).toEqual(["main", sceneId]);
		expect(findCompound(afterCreate).id).toBe(compound.elementId);
		expect(editor.selection.getSelectedElements()).toEqual([compound]);
		expect(getHost(afterCreate).tracks.main.elements[0].startTime).toBe(t(0));

		editor.command.undo();
		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual(["main"]);
		expect(layout(editor.scenes.getActiveScene().tracks)).toEqual(layout(getHost(original).tracks));

		editor.command.redo();
		expect(findCompound(editor.scenes.getScenes()).id).toBe(compound.elementId);

		const restored = editor.timeline.ungroupCompound(compound);
		expect(restored).toHaveLength(3);
		expect(layout(editor.scenes.getActiveScene().tracks)).toEqual(layout(getHost(original).tracks));
		editor.command.undo();
		expect(findCompound(editor.scenes.getScenes()).id).toBe(compound.elementId);
	});

	test("a scene used by a compound clip cannot be deleted (manager and command)", async () => {
		const editor = setup();
		const { compound, sceneId } = editor.timeline.createCompound({ elements: refs });

		await expect(editor.scenes.deleteScene({ sceneId })).rejects.toThrow(
			"Scene is used by a compound clip",
		);
		expect(() =>
			editor.command.execute({ command: new DeleteSceneCommand(sceneId) }),
		).toThrow("Scene is used by a compound clip");
		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual(["main", sceneId]);

		// Once nothing points at it, it can go.
		editor.timeline.deleteElements({ elements: [compound] });
		await editor.scenes.deleteScene({ sceneId });
		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual(["main"]);
	});

	test("editing inside the nested scene updates sourceDuration, and Undo restores it", async () => {
		const editor = setup();
		const { sceneId } = editor.timeline.createCompound({ elements: refs });
		await editor.scenes.switchToScene({ sceneId });
		const boxTrack = editor.scenes
			.getActiveScene()
			.tracks.overlay.find((tr) => tr.elements.some((e) => e.id === "box"));
		editor.timeline.updateElements({
			updates: [{ trackId: boxTrack?.id ?? "", elementId: "box", patch: { duration: t(8) } }],
		});
		let clip = findCompound(editor.scenes.getScenes());
		expect([clip.sourceDuration, clip.duration, clip.trimEnd]).toEqual([t(8), t(4), t(4)]);

		editor.command.undo();
		clip = findCompound(editor.scenes.getScenes());
		expect([clip.sourceDuration, clip.duration, clip.trimEnd]).toEqual([t(4), t(4), t(0)]);
	});

	test("insert and move follow the content rule for compound clips", () => {
		const editor = setup();
		// Audio-only compound: auto-insert another reference to it → it goes to an audio track.
		const { sceneId: audioScene } = editor.timeline.createCompound({
			elements: [{ trackId: "t-music", elementId: "music" }],
		});
		const command = new InsertElementCommand({
			element: compoundClip(audioScene, 20, 2),
			placement: { mode: "auto" },
		});
		editor.command.execute({ command });
		const inserted = allTracks(editor.scenes.getActiveScene().tracks).find(
			(tr) => tr.id === command.getTrackId(),
		);
		expect(inserted?.type).toBe("audio");
		expect(inserted?.elements.some((e) => e.id === command.getElementId())).toBe(true);

		// A visual compound cannot be moved onto an audio track.
		const { compound } = editor.timeline.createCompound({
			elements: [
				{ trackId: "t-text", elementId: "title" },
				{ trackId: "t-gfx", elementId: "box" },
			],
		});
		const audioTrackId = inserted?.id ?? "";
		expect(() =>
			editor.timeline.moveElements({
				moves: [
					{
						sourceTrackId: compound.trackId,
						targetTrackId: audioTrackId,
						elementId: compound.elementId,
						newStartTime: t(40),
					},
				],
			}),
		).toThrow("compound elements cannot be placed on audio tracks");
		const tracks = editor.scenes.getActiveScene().tracks;
		expect(allElements(tracks.audio).some((e) => e.id === compound.elementId)).toBe(false);
	});

	test("cycles are rejected before anything changes: insert, sceneId update and batches", async () => {
		const editor = setup();
		const { compound, sceneId } = editor.timeline.createCompound({ elements: refs });
		const hostBefore = editor.scenes.getScenes();

		// sceneId update in the host: the clip would contain its own scene.
		expect(() =>
			editor.timeline.updateElements({
				updates: [{ ...compound, patch: { sceneId: "main" } as Partial<CompoundElement> }],
			}),
		).toThrow(CompoundCycleError);
		expect(editor.scenes.getScenes()).toBe(hostBefore);

		// Insert into the nested scene a clip that references the host.
		await editor.scenes.switchToScene({ sceneId });
		const nestedBefore = editor.scenes.getActiveScene().tracks;
		expect(() =>
			editor.timeline.insertElement({
				element: compoundClip("main", 0, 1),
				placement: { mode: "auto" },
			}),
		).toThrow(CompoundCycleError);
		expect(editor.scenes.getActiveScene().tracks).toBe(nestedBefore);

		// Batch: a valid rename followed by a cyclic insert → nothing is applied.
		const boxTrack = nestedBefore.overlay.find((tr) => tr.elements.some((e) => e.id === "box"));
		const batch = new BatchCommand([
			new UpdateElementsCommand({
				updates: [{ trackId: boxTrack?.id ?? "", elementId: "box", patch: { name: "renamed" } }],
			}),
			new InsertElementCommand({ element: compoundClip("main", 0, 1), placement: { mode: "auto" } }),
		]);
		expect(() => editor.command.execute({ command: batch })).toThrow(CompoundCycleError);
		const box = allElements(allTracks(editor.scenes.getActiveScene().tracks)).find((e) => e.id === "box");
		expect(box?.name).toBe("box");
		expect(editor.command.canUndo()).toBe(true); // only the create is in history
		editor.command.undo();
		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual(["main"]);
	});

	test("a compound that loses its visuals stays on its video track and can still be moved", async () => {
		const editor = setup();
		const { compound, sceneId } = editor.timeline.createCompound({ elements: refs });
		await editor.scenes.switchToScene({ sceneId });
		const visual = allTracks(editor.scenes.getActiveScene().tracks).flatMap((track) =>
			track.elements
				.filter((element) => element.type !== "audio")
				.map((element) => ({ trackId: track.id, elementId: element.id })),
		);
		editor.timeline.deleteElements({ elements: visual });
		await editor.scenes.switchToScene({ sceneId: "main" });

		editor.timeline.moveElements({
			moves: [
				{
					sourceTrackId: compound.trackId,
					targetTrackId: compound.trackId,
					elementId: compound.elementId,
					newStartTime: t(3),
				},
			],
		});
		const host = editor.scenes.getActiveScene();
		expect(findCompound([host]).startTime).toBe(t(3));
		// Its audio still plays from the video track.
		const expanded = expandCompoundAudioTracks({ tracks: host.tracks, scenes: editor.scenes.getScenes() });
		expect(allElements(expanded.audio).map((e) => e.id)).toEqual([`${compound.elementId}/music`]);
	});

	test("an audio-only compound that gains visuals moves to a video track in the same undo step", async () => {
		const editor = setup();
		const { compound, sceneId } = editor.timeline.createCompound({
			elements: [{ trackId: "t-music", elementId: "music" }],
		});
		const onAudio = () =>
			editor.scenes
				.getScenes()
				.find((s) => s.id === "main")
				?.tracks.audio.some((track) => track.elements.some((e) => e.id === compound.elementId));
		const videoTrackId = () =>
			editor.scenes
				.getScenes()
				.find((s) => s.id === "main")
				?.tracks.overlay.find((track) => track.elements.some((e) => e.id === compound.elementId))?.id;
		expect(onAudio()).toBe(true);

		await editor.scenes.switchToScene({ sceneId });
		editor.timeline.insertElement({
			element: {
				type: "text",
				name: "caption",
				startTime: t(0),
				duration: t(1),
				trimStart: t(0),
				trimEnd: t(0),
				params: { content: "caption" },
			},
			placement: { mode: "auto" },
		});
		expect(onAudio()).toBe(false);
		const relocatedTo = videoTrackId();
		expect(relocatedTo).toBeDefined();

		editor.command.undo();
		expect(onAudio()).toBe(true);
		expect(videoTrackId()).toBeUndefined();
		editor.command.redo();
		expect(videoTrackId()).toBe(relocatedTo);

		// A later move along that track works, and undo/redo replays cleanly.
		await editor.scenes.switchToScene({ sceneId: "main" });
		editor.timeline.moveElements({
			moves: [
				{
					sourceTrackId: relocatedTo ?? "",
					targetTrackId: relocatedTo ?? "",
					elementId: compound.elementId,
					newStartTime: t(5),
				},
			],
		});
		expect(findCompound(editor.scenes.getScenes()).startTime).toBe(t(5));
		editor.command.undo();
		editor.command.undo();
		expect(onAudio()).toBe(true);
		editor.command.redo();
		editor.command.redo();
		expect(videoTrackId()).toBe(relocatedTo);
		expect(findCompound(editor.scenes.getScenes()).startTime).toBe(t(5));
	});

	test("Undo after leaving a nested scene reverts the nested edit, not the open scene", async () => {
		const editor = setup();
		const { sceneId } = editor.timeline.createCompound({ elements: refs });
		await editor.scenes.switchToScene({ sceneId });
		const boxTrack = editor.scenes
			.getActiveScene()
			.tracks.overlay.find((track) => track.elements.some((e) => e.id === "box"));
		editor.timeline.updateElements({
			updates: [{ trackId: boxTrack?.id ?? "", elementId: "box", patch: { name: "edited" } }],
		});
		await editor.scenes.switchToScene({ sceneId: "main" });
		const mainTracks = editor.scenes.getActiveScene().tracks;
		const boxName = () =>
			allElements(allTracks(editor.scenes.getScenes().find((s) => s.id === sceneId)?.tracks ?? mainTracks)).find(
				(e) => e.id === "box",
			)?.name;
		expect(boxName()).toBe("edited");

		editor.command.undo();
		expect(editor.scenes.getActiveScene().id).toBe("main");
		expect(layout(editor.scenes.getActiveScene().tracks)).toEqual(layout(mainTracks));
		expect(boxName()).toBe("box");

		editor.command.redo();
		expect(editor.scenes.getActiveScene().id).toBe("main");
		expect(layout(editor.scenes.getActiveScene().tracks)).toEqual(layout(mainTracks));
		expect(boxName()).toBe("edited");
	});
});

describe("insertion and batch rollback", () => {
	function emptyProject() {
		const scenes = fixture();
		const host = getHost(scenes);
		host.tracks = {
			overlay: [],
			main: { ...host.tracks.main, elements: [] },
			audio: [],
		};
		const editor = setup(scenes);
		(editor.media as unknown as { assets: MediaAsset[] }).assets = [
			{
				id: "clip-media",
				name: "clip",
				type: "video",
				file: new File([], "clip.mp4"),
				url: "blob:clip",
				width: 1080,
				height: 1920,
				fps: 25,
			} as MediaAsset,
		];
		return editor;
	}
	const firstVideo = () =>
		new InsertElementCommand({
			element: {
				type: "video",
				name: "clip",
				mediaId: "clip-media",
				startTime: t(0),
				duration: t(2),
				trimStart: t(0),
				trimEnd: t(0),
				params: {},
			},
			placement: { mode: "auto" },
		});
	const settingsOf = (editor: ReturnType<typeof setup>) => {
		const { canvasSize, originalCanvasSize, fps } = editor.project.getActive().settings;
		return { canvasSize, originalCanvasSize: originalCanvasSize ?? null, fps };
	};

	test("a failed batch undoes the project settings a first-video insertion changed", () => {
		const editor = emptyProject();
		const before = settingsOf(editor);
		const batch = new BatchCommand([
			firstVideo(),
			new MoveElementCommand({
				moves: [{ sourceTrackId: "missing", targetTrackId: "missing", elementId: "x", newStartTime: t(0) }],
			}),
		]);
		expect(() => editor.command.execute({ command: batch })).toThrow("Source track or element not found");
		expect(settingsOf(editor)).toEqual(before);
		expect(editor.scenes.getActiveScene().tracks.main.elements).toHaveLength(0);
		expect(editor.command.canUndo()).toBe(false);
	});

	test("undo and redo of a first-video insertion restore and re-apply canvas size and fps", () => {
		const editor = emptyProject();
		const before = settingsOf(editor);
		editor.command.execute({ command: firstVideo() });
		const after = settingsOf(editor);
		expect(after.canvasSize).toEqual({ width: 1080, height: 1920 });
		expect(after.originalCanvasSize).toEqual({ width: 1080, height: 1920 });
		expect(after.fps).not.toEqual(before.fps);

		editor.command.undo();
		expect(settingsOf(editor)).toEqual(before);
		editor.command.redo();
		expect(settingsOf(editor)).toEqual(after);
	});
});
