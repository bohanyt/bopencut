import { describe, expect, mock, test } from "bun:test";
import type { TProject } from "@/project/types";
import { findCompound, fixture, getHost, layout, refs, t } from "./compound-fixtures";

// Another test file replaces opencut-wasm with a partial mock and Bun keeps that module shape,
// so stub the GPU modules (unused here) before EditorCore pulls them in.
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");

describe("compound clip commands", () => {
	test("editor API: one Undo reverts create, Redo replays it, ripple does not shift neighbours", () => {
		const editor = EditorCore.getInstance();
		// No autosave from this test (it would write to storage after the test ends).
		editor.save.stop();
		editor.command.clear();
		editor.command.isRippleEnabled = true;
		const original = fixture();
		editor.project.setActiveProject({
			project: {
				metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
				scenes: original,
				currentSceneId: "main",
				settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
			} as unknown as TProject,
		});
		editor.scenes.setScenes({ scenes: original, activeSceneId: "main" });

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
		editor.command.isRippleEnabled = false;
		EditorCore.reset();
	});
});
