import type { CompoundElement, TScene, TimelineTrack } from "@/timeline";
import { isCompoundElement, isCompoundScene } from "@/timeline/compound";
import type { MediaTime } from "@/wasm";

// Where the open scene sits in the compound tree, for the breadcrumb and Esc/back.
// Pure: the scenes manager keeps the hints, these functions only read scenes.

export interface CompoundCrumb {
	sceneId: string;
	name: string;
}

function referencesScene(scene: TScene, sceneId: string): boolean {
	const tracks: TimelineTrack[] = [
		...scene.tracks.overlay,
		scene.tracks.main,
		...scene.tracks.audio,
	];
	return tracks.some((track) =>
		track.elements.some(
			(element) => isCompoundElement(element) && element.sceneId === sceneId,
		),
	);
}

/**
 * The scene a compound scene was opened from. `hint` (the scene the user entered it from) wins
 * while it still contains the clip; otherwise any scene containing it, user scenes first.
 * Null for user scenes and for compound content no scene uses any more.
 */
export function getCompoundParentSceneId({
	scenes,
	sceneId,
	hint,
}: {
	scenes: TScene[];
	sceneId: string;
	hint?: string;
}): string | null {
	const scene = scenes.find((candidate) => candidate.id === sceneId);
	if (!scene || !isCompoundScene(scene)) return null;
	const hinted = hint ? scenes.find((candidate) => candidate.id === hint) : undefined;
	if (hinted && referencesScene(hinted, sceneId)) return hinted.id;
	const parents = scenes.filter((candidate) => referencesScene(candidate, sceneId));
	const parent =
		parents.find((candidate) => !isCompoundScene(candidate)) ?? parents[0];
	return parent?.id ?? null;
}

/** Root user scene first, open scene last. A user scene alone gives a single crumb. */
export function getCompoundPath({
	scenes,
	sceneId,
	parentHints,
}: {
	scenes: TScene[];
	sceneId: string;
	parentHints?: ReadonlyMap<string, string>;
}): CompoundCrumb[] {
	const path: CompoundCrumb[] = [];
	const visited = new Set<string>();
	let current: string | null = sceneId;
	while (current && !visited.has(current)) {
		visited.add(current);
		const scene = scenes.find((candidate) => candidate.id === current);
		if (!scene) break;
		path.unshift({ sceneId: scene.id, name: scene.name });
		current = getCompoundParentSceneId({
			scenes,
			sceneId: scene.id,
			hint: parentHints?.get(scene.id),
		});
	}
	return path;
}

/**
 * Nested time shown when entering a compound at the parent playhead `parentTime`: the same frame
 * inside it, or null when the playhead is outside the clip.
 */
export function getNestedTimeAtParentTime({
	element,
	parentTime,
}: {
	element: CompoundElement;
	parentTime: MediaTime;
}): MediaTime | null {
	if (
		parentTime < element.startTime ||
		parentTime >= element.startTime + element.duration
	) {
		return null;
	}
	return (parentTime - element.startTime + element.trimStart) as MediaTime;
}
