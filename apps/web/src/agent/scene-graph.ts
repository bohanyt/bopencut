// Addressing inside compound clips for the agent path. Every element lives in one scene and is
// reached from the root timeline through a chain of compound clips (its `path`). Times inside a
// nested scene are relative to that scene; `toRootInterval` maps them to the root timeline.
import type { CompoundElement, ElementRef, SceneTracks, TScene, TimelineElement, TimelineTrack } from "@/timeline";
import { isCompoundElement, isCompoundScene, sceneReachesScene } from "@/timeline/compound";

export type AgentMatch = { agentId?: string; id?: string; sceneId?: string; scene?: string; path?: string[] };
export type SceneInstance = { sceneId: string; path: string[]; chain: CompoundElement[] };
export type ElementHit = { sceneId: string; track: TimelineTrack; index: number; element: TimelineElement };
export type ElementAddress = { sceneId: string; trackId: string | null; id: string; agentId: string | null; path: string[] | null };

export const orderedTracks = (tracks: SceneTracks): TimelineTrack[] => [...tracks.overlay, tracks.main, ...tracks.audio];

/**
 * The timeline the agent reads and edits: the open scene, or (while the human is inside a compound
 * clip) the user scene that contains it, preferring the main scene.
 */
export function getRootScene(scenes: TScene[], activeSceneId: string | null): TScene | null {
	const active = scenes.find((scene) => scene.id === activeSceneId);
	if (active && !isCompoundScene(active)) return active;
	const users = scenes.filter((scene) => !isCompoundScene(scene));
	const containing = active
		? users.filter((scene) => sceneReachesScene({ scenes, fromSceneId: scene.id, targetSceneId: active.id }))
		: [];
	return containing.find((scene) => scene.isMain) ?? containing[0] ?? users.find((scene) => scene.isMain) ?? users[0] ?? null;
}

/** Every place a scene shows up under the root, depth first (root first). A shared scene appears once per path. */
export function walkSceneInstances(scenes: TScene[], rootSceneId: string): SceneInstance[] {
	const byId = new Map(scenes.map((scene) => [scene.id, scene]));
	const instances: SceneInstance[] = [];
	const visit = (sceneId: string, path: string[], chain: CompoundElement[], stack: string[]) => {
		const scene = byId.get(sceneId);
		if (!scene) return;
		instances.push({ sceneId, path, chain });
		for (const track of orderedTracks(scene.tracks)) {
			for (const element of track.elements) {
				if (!isCompoundElement(element) || stack.includes(element.sceneId)) continue;
				visit(element.sceneId, [...path, element.id], [...chain, element], [...stack, element.sceneId]);
			}
		}
	};
	visit(rootSceneId, [], [], [rootSceneId]);
	return instances;
}

/** First path of each scene reachable from the root (depth-first order). */
export function getScenePaths(scenes: TScene[], rootSceneId: string): Map<string, string[]> {
	const paths = new Map<string, string[]>();
	for (const instance of walkSceneInstances(scenes, rootSceneId)) {
		if (!paths.has(instance.sceneId)) paths.set(instance.sceneId, instance.path);
	}
	return paths;
}

/**
 * Maps [start, end) in a nested scene's own time to root time through every enclosing clip
 * (`chain`, outermost first): each clip shows only its trim window [trimStart, trimStart + duration)
 * and shifts it by startTime - trimStart. Returns null when an enclosing clip trims it out.
 */
export function toRootInterval(start: number, end: number, chain: CompoundElement[]): [number, number] | null {
	for (let k = chain.length - 1; k >= 0; k--) {
		const clip = chain[k];
		const from = Math.max(start, clip.trimStart);
		const to = Math.min(end, clip.trimStart + clip.duration);
		if (to <= from) return null;
		const shift = clip.startTime - clip.trimStart;
		start = from + shift;
		end = to + shift;
	}
	return [start, end];
}

function findInScene(scene: TScene, match: AgentMatch): ElementHit | null {
	const find = (test: (element: TimelineElement) => boolean) => {
		for (const track of orderedTracks(scene.tracks)) {
			const index = track.elements.findIndex(test);
			if (index >= 0) return { sceneId: scene.id, track, index, element: track.elements[index] };
		}
		return null;
	};
	return (match.id ? find((element) => element.id === match.id) : null)
		?? (match.agentId ? find((element) => element.agentId === match.agentId) : null);
}

/** Follows `path` (compound clip ids or agentIds) from the root to the scene inside the last clip. */
export function resolveScenePath(scenes: TScene[], rootSceneId: string, path: string[]): { sceneId: string } | { error: string } {
	let sceneId = rootSceneId;
	for (const entry of path) {
		const scene = scenes.find((s) => s.id === sceneId);
		const hit = scene ? findInScene(scene, { id: entry, agentId: entry }) : null;
		if (!hit || !isCompoundElement(hit.element)) return { error: `path entry "${entry}" is not a compound clip in scene ${sceneId}` };
		sceneId = hit.element.sceneId;
	}
	return { sceneId };
}

const isMatch = (value: unknown): value is AgentMatch =>
	!!value && typeof value === "object" && !Array.isArray(value);

/**
 * Finds one element. `{agentId}` / `{id}` search every scene reachable from the root and fail when
 * the element is in more than one scene; `sceneId` or `path` (compound ids from the root) narrows
 * the search to one scene. `id` wins over `agentId` when both are given.
 */
export function resolveMatch(scenes: TScene[], rootSceneId: string, match: unknown): { hit: ElementHit } | { error: string } {
	if (!isMatch(match) || !((typeof match.id === "string" && match.id) || (typeof match.agentId === "string" && match.agentId))) {
		return { error: "invalid match: give agentId or id" };
	}
	let sceneIds: string[];
	const explicitScene = match.sceneId ?? match.scene;
	if (match.path !== undefined) {
		if (!Array.isArray(match.path) || match.path.some((entry) => typeof entry !== "string")) return { error: "invalid match path" };
		const resolved = resolveScenePath(scenes, rootSceneId, match.path);
		if ("error" in resolved) return resolved;
		if (explicitScene && explicitScene !== resolved.sceneId) return { error: "match sceneId and path point at different scenes" };
		sceneIds = [resolved.sceneId];
	} else if (explicitScene) {
		if (!scenes.some((scene) => scene.id === explicitScene)) return { error: `scene not found: ${explicitScene}` };
		sceneIds = [explicitScene];
	} else {
		sceneIds = [...getScenePaths(scenes, rootSceneId).keys()];
	}
	const hits = sceneIds.flatMap((sceneId) => {
		const scene = scenes.find((s) => s.id === sceneId);
		const hit = scene ? findInScene(scene, match) : null;
		return hit ? [hit] : [];
	});
	if (hits.length === 0) return { error: "item not found (it may have been deleted in the editor)" };
	if (hits.length > 1) {
		return { error: `ambiguous match: found in scenes ${hits.map((hit) => hit.sceneId).join(", ")}; add sceneId or path` };
	}
	return { hit: hits[0] };
}

/** Scene a `track.compound` target points at: the content of a matched compound clip, or the scene at a bare `path`. */
export function resolveCompoundTarget(scenes: TScene[], rootSceneId: string, target: unknown): { sceneId: string } | { error: string } {
	if (!isMatch(target)) return { error: "invalid compound target" };
	if (!target.id && !target.agentId) {
		if (Array.isArray(target.path) && target.path.every((entry) => typeof entry === "string")) {
			return resolveScenePath(scenes, rootSceneId, target.path);
		}
		return { error: "invalid compound target: give agentId, id or path" };
	}
	const resolved = resolveMatch(scenes, rootSceneId, target);
	if ("error" in resolved) return resolved;
	if (!isCompoundElement(resolved.hit.element)) return { error: "target is not a compound clip" };
	return { sceneId: resolved.hit.element.sceneId };
}

export function addressOf(scenes: TScene[], rootSceneId: string, sceneId: string, elementId: string): ElementAddress {
	const scene = scenes.find((s) => s.id === sceneId);
	const track = scene ? orderedTracks(scene.tracks).find((t) => t.elements.some((e) => e.id === elementId)) : undefined;
	const element = track?.elements.find((e) => e.id === elementId);
	return {
		sceneId, trackId: track?.id ?? null, id: elementId, agentId: element?.agentId ?? null,
		path: getScenePaths(scenes, rootSceneId).get(sceneId) ?? null,
	};
}

/**
 * Element refs to select in the open scene for changed elements: the element itself when it is in
 * that scene, otherwise the outermost compound clip in that scene that contains it.
 */
export function selectionInScene(scenes: TScene[], rootSceneId: string, activeSceneId: string, touched: { sceneId: string; elementId: string }[]): ElementRef[] {
	const active = scenes.find((scene) => scene.id === activeSceneId);
	if (!active) return [];
	const instances = walkSceneInstances(scenes, rootSceneId);
	const refs = new Map<string, ElementRef>();
	const add = (elementId: string) => {
		const track = orderedTracks(active.tracks).find((t) => t.elements.some((e) => e.id === elementId));
		if (track) refs.set(`${track.id}\u0000${elementId}`, { trackId: track.id, elementId });
	};
	for (const { sceneId, elementId } of touched) {
		if (sceneId === activeSceneId) { add(elementId); continue; }
		for (const instance of instances) {
			if (instance.sceneId !== sceneId) continue;
			const hostOf = (k: number) => (k === 0 ? rootSceneId : instance.chain[k - 1].sceneId);
			const k = instance.chain.findIndex((_, i) => hostOf(i) === activeSceneId);
			if (k >= 0) { add(instance.chain[k].id); break; }
		}
	}
	return [...refs.values()];
}
