import { EditorCore } from "@/core";
import type { SceneTracks, TScene } from "@/timeline";

// Duplicate and paste of compound clips add deep-copied nested scenes next to the host change.

/** Adds the copied nested scenes first, so the new clips never point at a missing scene. */
export function applyCopiedScenes({
	tracks,
	scenes,
}: {
	tracks: SceneTracks;
	scenes: TScene[];
}): void {
	const editor = EditorCore.getInstance();
	if (scenes.length > 0) {
		editor.scenes.setScenes({ scenes: [...editor.scenes.getScenes(), ...scenes] });
	}
	editor.timeline.updateTracks(tracks);
}

/** Undo: restores the host tracks first, then drops the copies nothing points at any more. */
export function removeCopiedScenes({
	tracks,
	scenes,
}: {
	tracks: SceneTracks;
	scenes: TScene[];
}): void {
	const editor = EditorCore.getInstance();
	editor.timeline.updateTracks(tracks);
	if (scenes.length > 0) {
		const copyIds = new Set(scenes.map((scene) => scene.id));
		editor.scenes.setScenes({
			scenes: editor.scenes.getScenes().filter((scene) => !copyIds.has(scene.id)),
		});
	}
}
