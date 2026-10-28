import { afterEach, describe, expect, mock, test } from "bun:test";
import type { CompoundElement, CreateCompoundElement, TScene } from "@/timeline";
import type { TProject } from "@/project/types";
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
const { InsertElementCommand, UpdateElementsCommand } = await import("@/commands/timeline");
const { CompoundCycleError } = await import("@/timeline/compound");

function setup(scenes: TScene[] = fixture()) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	// No autosave from these tests (it would write to storage after the test ends).
	editor.save.stop();
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
});
