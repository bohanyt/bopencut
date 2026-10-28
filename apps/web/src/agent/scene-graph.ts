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

/** Most paths reported per scene. Shared nesting (split halves of split halves) multiplies paths, so they are capped. */
export const MAX_INSTANCES_PER_SCENE = 32;

/** Scenes reachable from the root, each once, in depth-first discovery order (root first). */
export function getReachableScenes(scenes: TScene[], rootSceneId: string): TScene[] {
	const byId = new Map(scenes.map((scene) => [scene.id, scene]));
	const order: TScene[] = [];
	const seen = new Set<string>();
	const visit = (sceneId: string) => {
		const scene = byId.get(sceneId);
		if (!scene || seen.has(sceneId)) return;
		seen.add(sceneId);
		order.push(scene);
		for (const track of orderedTracks(scene.tracks)) {
			for (const element of track.elements) if (isCompoundElement(element)) visit(element.sceneId);
		}
	};
	visit(rootSceneId);
	return order;
}

export type SceneInstances = { instances: SceneInstance[]; truncated: boolean };

/**
 * The places each reachable scene shows up under the root, at most `limit` per scene. Built per
 * scene from its parents' (already capped) instances, so cost grows with scenes × clips × limit,
 * never with the number of paths. Order: parents in discovery order, then their instances, then
 * the referencing clips in track order; the first instance gives the scene's `path`.
 * `truncated` = some paths were left out (here or in an enclosing scene).
 */
export function getSceneInstances(scenes: TScene[], rootSceneId: string, limit = MAX_INSTANCES_PER_SCENE): Map<string, SceneInstances> {
	const reachable = getReachableScenes(scenes, rootSceneId);
	const parents = new Map<string, { sceneId: string; clip: CompoundElement }[]>();
	for (const scene of reachable) {
		for (const track of orderedTracks(scene.tracks)) {
			for (const element of track.elements) {
				if (!isCompoundElement(element)) continue;
				const list = parents.get(element.sceneId);
				if (list) list.push({ sceneId: scene.id, clip: element });
				else parents.set(element.sceneId, [{ sceneId: scene.id, clip: element }]);
			}
		}
	}
	const memo = new Map<string, SceneInstances>();
	const compute = (sceneId: string, visiting: Set<string>): SceneInstances => {
		const known = memo.get(sceneId);
		if (known) return known;
		if (sceneId === rootSceneId) {
			const root = { instances: [{ sceneId, path: [], chain: [] }], truncated: false };
			memo.set(sceneId, root);
			return root;
		}
		visiting.add(sceneId);
		const instances: SceneInstance[] = [];
		let truncated = false;
		outer: for (const { sceneId: parentId, clip } of parents.get(sceneId) ?? []) {
			if (visiting.has(parentId)) continue; // a cycle; the scenes manager rejects these anyway
			const parent = compute(parentId, visiting);
			truncated ||= parent.truncated;
			for (const instance of parent.instances) {
				if (instances.length >= limit) { truncated = true; break outer; }
				instances.push({ sceneId, path: [...instance.path, clip.id], chain: [...instance.chain, clip] });
			}
		}
		visiting.delete(sceneId);
		const result = { instances, truncated };
		memo.set(sceneId, result);
		return result;
	};
	const result = new Map<string, SceneInstances>();
	for (const scene of reachable) result.set(scene.id, compute(scene.id, new Set()));
	return result;
}

/** First path of each scene reachable from the root. */
export function getScenePaths(scenes: TScene[], rootSceneId: string): Map<string, string[]> {
	const paths = new Map<string, string[]>();
	for (const [sceneId, { instances }] of getSceneInstances(scenes, rootSceneId, 1)) {
		if (instances[0]) paths.set(sceneId, instances[0].path);
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

function findInScene(scene: TScene, test: (element: TimelineElement) => boolean): ElementHit | null {
	for (const track of orderedTracks(scene.tracks)) {
		const index = track.elements.findIndex(test);
		if (index >= 0) return { sceneId: scene.id, track, index, element: track.elements[index] };
	}
	return null;
}

/** Follows `path` (compound clip ids or agentIds) from the root to the scene inside the last clip. */
export function resolveScenePath(scenes: TScene[], rootSceneId: string, path: string[]): { sceneId: string } | { error: string } {
	let sceneId = rootSceneId;
	for (const entry of path) {
		const scene = scenes.find((s) => s.id === sceneId);
		const hit = scene ? findInScene(scene, (element) => element.id === entry) ?? findInScene(scene, (element) => element.agentId === entry) : null;
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
 * the search to one scene. When both are given, `id` is searched in every candidate scene first and
 * `agentId` is only tried if no element has that id.
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
		sceneIds = getReachableScenes(scenes, rootSceneId).map((scene) => scene.id);
	}
	const candidates = sceneIds.flatMap((sceneId) => scenes.filter((s) => s.id === sceneId));
	const search = (test: (element: TimelineElement) => boolean) => candidates.flatMap((scene) => findInScene(scene, test) ?? []);
	let hits = match.id ? search((element) => element.id === match.id) : [];
	if (hits.length === 0 && match.agentId) hits = search((element) => element.agentId === match.agentId);
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

/** Address of an element; pass `paths` (getScenePaths) when resolving many addresses against the same scenes. */
export function addressOf(scenes: TScene[], rootSceneId: string, sceneId: string, elementId: string, paths = getScenePaths(scenes, rootSceneId)): ElementAddress {
	const scene = scenes.find((s) => s.id === sceneId);
	const track = scene ? orderedTracks(scene.tracks).find((t) => t.elements.some((e) => e.id === elementId)) : undefined;
	const element = track?.elements.find((e) => e.id === elementId);
	return {
		sceneId, trackId: track?.id ?? null, id: elementId, agentId: element?.agentId ?? null,
		path: paths.get(sceneId) ?? null,
	};
}

/**
 * Element refs to select in the open scene for changed elements: the element itself when it is in
 * that scene, otherwise the first compound clip in that scene that contains it (at any depth).
 */
export function selectionInScene(scenes: TScene[], activeSceneId: string, touched: { sceneId: string; elementId: string }[]): ElementRef[] {
	const active = scenes.find((scene) => scene.id === activeSceneId);
	if (!active) return [];
	const refs = new Map<string, ElementRef>();
	const add = (trackId: string, elementId: string) => refs.set(`${trackId}\u0000${elementId}`, { trackId, elementId });
	const tracks = orderedTracks(active.tracks);
	for (const { sceneId, elementId } of touched) {
		for (const track of tracks) {
			const element = track.elements.find((e) => sceneId === activeSceneId
				? e.id === elementId
				: isCompoundElement(e) && sceneReachesScene({ scenes, fromSceneId: e.sceneId, targetSceneId: sceneId }));
			if (element) { add(track.id, element.id); break; }
		}
	}
	return [...refs.values()];
}
