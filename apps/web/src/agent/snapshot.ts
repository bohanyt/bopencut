// What the agent sees: the root timeline (`tracks`, unchanged shape) plus every compound clip's
// content (`compounds`), with relative times, root-time visible intervals, and addresses.
import type { CompoundElement, TScene, TimelineElement, TimelineTrack } from "@/timeline";
import { calculateTotalDuration } from "@/timeline";
import { isCompoundElement } from "@/timeline/compound";
import { TICKS_PER_SECOND } from "@/wasm";
import type { EditItem } from "./edit-log";
import { type SceneInstance, toRootInterval, walkSceneInstances } from "./scene-graph";

/** Ticks → seconds (3 decimals); other values pass through. */
export const s = (ticks: unknown) => (typeof ticks === "number" ? Math.round((ticks / TICKS_PER_SECOND) * 1000) / 1000 : ticks);
const sec = (ticks: number) => s(ticks) as number;

export function animationSeconds(value: any): any {
	if (Array.isArray(value)) return value.map(animationSeconds);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === "time" || key === "dt" ? s(entry) : animationSeconds(entry)]));
}

const offsetOf = (chain: CompoundElement[]) => chain.reduce((sum, clip) => sum + clip.startTime - clip.trimStart, 0);

function instancesByScene(scenes: TScene[], rootSceneId: string): Map<string, SceneInstance[]> {
	const byScene = new Map<string, SceneInstance[]>();
	for (const instance of walkSceneInstances(scenes, rootSceneId)) byScene.set(instance.sceneId, [...(byScene.get(instance.sceneId) ?? []), instance]);
	return byScene;
}

export function buildSceneSnapshot({ scenes, rootSceneId, mediaName }: { scenes: TScene[]; rootSceneId: string; mediaName: Map<string, string> }) {
	const byScene = instancesByScene(scenes, rootSceneId);
	const element = (e: TimelineElement, sceneId: string) => {
		const own = byScene.get(sceneId) ?? [];
		const x = e as any;
		return {
			id: e.id, agentId: e.agentId ?? null, type: e.type, name: e.name, media: x.mediaId ? mediaName.get(x.mediaId) ?? null : null,
			start: sec(e.startTime), duration: sec(e.duration), end: sec(e.startTime + e.duration), trimStart: sec(e.trimStart), trimEnd: sec(e.trimEnd),
			effectType: x.effectType ?? null, graphic: x.definitionId ? { definitionId: x.definitionId } : null, icon: x.definitionId === "icon" ? { name: e.params.iconName, color: e.params.color } : null, groupId: e.groupId ?? null, params: e.params, hasKeyframes: !!e.animations && Object.keys(e.animations).length > 0,
			sceneId, path: own[0]?.path ?? null,
			// Where it shows in the root timeline, once per path to its scene; [] = trimmed out by an enclosing clip.
			visible: own.flatMap((instance) => {
				const interval = toRootInterval(e.startTime, e.startTime + e.duration, instance.chain);
				return interval ? [{ start: sec(interval[0]), end: sec(interval[1]), path: instance.path }] : [];
			}),
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
	const compounds = [...byScene.entries()].filter(([sceneId]) => sceneId !== rootSceneId).flatMap(([sceneId, instances]) => {
		const scene = scenes.find((s) => s.id === sceneId);
		if (!scene) return [];
		return [{
			sceneId, name: scene.name, kind: scene.kind ?? null, duration: sec(calculateTotalDuration({ tracks: scene.tracks })), path: instances[0].path,
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

/** Flat list of every element under the root (each scene once) for the human edit log. */
export function buildEditItems({ scenes, rootSceneId, mediaName }: { scenes: TScene[]; rootSceneId: string; mediaName: Map<string, string> }): EditItem[] {
	const byScene = instancesByScene(scenes, rootSceneId);
	return [...byScene.entries()].flatMap(([sceneId, instances]) => {
		const scene = scenes.find((s) => s.id === sceneId);
		if (!scene) return [];
		return [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio].flatMap((track) => track.elements.map((e: TimelineElement) => ({
			id: e.id, agentId: e.agentId ?? null, name: e.name, media: mediaName.get((e as any).mediaId) ?? null, type: e.type, track: track.name,
			sceneId, path: instances[0].path,
			startTime: sec(e.startTime), duration: sec(e.duration), trimStart: sec(e.trimStart), trimEnd: sec(e.trimEnd),
			params: structuredClone(e.params ?? {}), animations: animationSeconds(e.animations ?? {}),
		})));
	});
}
