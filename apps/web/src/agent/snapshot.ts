// What the agent sees: the root timeline (`tracks`, unchanged shape) plus every compound clip's
// content (`compounds`), with relative times, root-time visible intervals, and addresses.
import type { CompoundElement, TScene, TimelineElement, TimelineTrack } from "@/timeline";
import { calculateTotalDuration } from "@/timeline";
import { isCompoundElement } from "@/timeline/compound";
import { TICKS_PER_SECOND } from "@/wasm";
import type { EditItem } from "./edit-log";
import { getSceneInstances, toRootInterval } from "./scene-graph";

/** Ticks → seconds (3 decimals); other values pass through. */
export const s = (ticks: unknown) => (typeof ticks === "number" ? Math.round((ticks / TICKS_PER_SECOND) * 1000) / 1000 : ticks);
const sec = (ticks: number) => s(ticks) as number;

export function animationSeconds(value: any): any {
	if (Array.isArray(value)) return value.map(animationSeconds);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === "time" || key === "dt" ? s(entry) : animationSeconds(entry)]));
}

const offsetOf = (chain: CompoundElement[]) => chain.reduce((sum, clip) => sum + clip.startTime - clip.trimStart, 0);

export function buildSceneSnapshot({ scenes, rootSceneId, mediaName }: { scenes: TScene[]; rootSceneId: string; mediaName: Map<string, string> }) {
	const byScene = getSceneInstances(scenes, rootSceneId);
	const element = (e: TimelineElement, sceneId: string) => {
		const { instances: own = [], truncated = false } = byScene.get(sceneId) ?? {};
		const x = e as any;
		return {
			id: e.id, agentId: e.agentId ?? null, type: e.type, name: e.name, media: x.mediaId ? mediaName.get(x.mediaId) ?? null : null, mediaId: x.mediaId ?? null,
			start: sec(e.startTime), duration: sec(e.duration), end: sec(e.startTime + e.duration), trimStart: sec(e.trimStart), trimEnd: sec(e.trimEnd),
			effectType: x.effectType ?? null, graphic: x.definitionId ? { definitionId: x.definitionId } : null, icon: x.definitionId === "icon" ? { name: e.params.iconName, color: e.params.color } : null, groupId: e.groupId ?? null, params: e.params, hasKeyframes: !!e.animations && Object.keys(e.animations).length > 0,
			sceneId, path: own[0]?.path ?? null,
			// Where it shows in the root timeline, once per path to its scene; [] = trimmed out by an enclosing clip.
			visible: own.flatMap((instance) => {
				const interval = toRootInterval(e.startTime, e.startTime + e.duration, instance.chain);
				return interval ? [{ start: sec(interval[0]), end: sec(interval[1]), path: instance.path }] : [];
			}),
			// Only the first MAX_INSTANCES_PER_SCENE paths of a shared scene are listed.
			...(truncated ? { truncated: true } : {}),
			...(isCompoundElement(e) ? { compound: { sceneId: e.sceneId, kind: "compound", volume: typeof e.params.volume === "number" ? e.params.volume : 0, muted: e.params.muted === true, sourceDuration: sec(e.sourceDuration ?? 0) } } : {}),
		};
	};
	const lane = (track: TimelineTrack, group: string, index: number, sceneId: string) => ({
		group, index, id: track.id, name: track.name, type: track.type, hidden: "hidden" in track ? track.hidden ?? false : false, muted: "muted" in track ? track.muted ?? false : false,
		elements: track.elements.map((e: TimelineElement) => element(e, sceneId)),
	});
	const lanes = (scene: TScene) => [
		...scene.tracks.overlay.map((track, i) => lane(track, "overlay", i, scene.id)),
		lane(scene.tracks.main, "main", 0, scene.id),
		...scene.tracks.audio.map((track, i) => lane(track, "audio", i, scene.id)),
	];
	const root = scenes.find((scene) => scene.id === rootSceneId);
	const compounds = [...byScene.entries()].filter(([sceneId]) => sceneId !== rootSceneId).flatMap(([sceneId, { instances, truncated }]) => {
		const scene = scenes.find((s) => s.id === sceneId);
		if (!scene || !instances[0]) return [];
		return [{
			sceneId, name: scene.name, kind: scene.kind ?? null, duration: sec(calculateTotalDuration({ tracks: scene.tracks })), path: instances[0].path, truncated,
			// Each clip that shows this content: root time = nested time + offset, inside `visible`.
			instances: instances.map((instance) => {
				const clip = instance.chain[instance.chain.length - 1];
				const interval = toRootInterval(clip.startTime, clip.startTime + clip.duration, instance.chain.slice(0, -1));
				return { path: instance.path, compoundId: clip.id, agentId: clip.agentId ?? null, offset: sec(offsetOf(instance.chain)), visible: interval ? [{ start: sec(interval[0]), end: sec(interval[1]) }] : [] };
			}),
			tracks: lanes(scene),
		}];
	});
	return { sceneId: rootSceneId, tracks: root ? lanes(root) : [], compounds };
}

/**
 * Flat list of every element under the root (each scene once) for the human edit log, with the
 * element's root-time span through its first path, so moving it between scenes can be told apart
 * from retiming it.
 */
export function buildEditItems({ scenes, rootSceneId, mediaName }: { scenes: TScene[]; rootSceneId: string; mediaName: Map<string, string> }): EditItem[] {
	const items: EditItem[] = [];
	for (const [sceneId, { instances }] of getSceneInstances(scenes, rootSceneId, 1)) {
		const scene = scenes.find((s) => s.id === sceneId);
		const first = instances[0];
		if (!scene || !first) continue;
		const offset = offsetOf(first.chain);
		for (const track of [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]) {
			for (const e of track.elements as TimelineElement[]) {
				const end = e.startTime + e.duration;
				const visible = toRootInterval(e.startTime, end, first.chain);
				items.push({
					id: e.id, agentId: e.agentId ?? null, name: e.name, media: mediaName.get((e as any).mediaId) ?? null, type: e.type, track: track.name,
					sceneId, path: first.path, ...(isCompoundElement(e) ? { contentSceneId: e.sceneId } : {}),
					startTime: sec(e.startTime), duration: sec(e.duration), trimStart: sec(e.trimStart), trimEnd: sec(e.trimEnd),
					rootStart: sec(visible ? visible[0] : e.startTime + offset), rootEnd: sec(visible ? visible[1] : end + offset),
					params: structuredClone(e.params ?? {}), animations: animationSeconds(e.animations ?? {}),
				});
			}
		}
	}
	return items;
}
