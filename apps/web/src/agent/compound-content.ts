// Compound clips built from agent definitions (draft `compound` op, `add` with `element.compound`,
// bundle elements with `compound`). The nested scene's tracks are built like a draft `add`, so
// every part stays a normal, editable element; times inside are relative to the clip's content.
import type { CompoundElement, SceneTracks, TScene } from "@/timeline";
import { calculateTotalDuration, updateElementInSceneTracks } from "@/timeline";
import { buildDefaultScene } from "@/timeline/scenes";
import { sceneHasVisualContent } from "@/timeline/compound";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { buildDefaultParamValues, getBuiltInElementParams } from "@/params/registry";
import { upsertPathKeyframe } from "@/animation";
import { type MediaTime, maxMediaTime, minMediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import { generateUUID } from "@/utils/id";
import { findTrackByName } from "./track-names";
import { orderedTracks } from "./scene-graph";
import {
	type AgentCompoundContent, type AgentElement, type AgentTrackRef, type AgentTrackType, type LoadedMedia, type PendingKeyframe,
	buildAgentElement, createAgentTrack, inferTrackType, secs,
} from "./elements";

export type BuildContext = {
	canvas: { width: number; height: number };
	keyframes: PendingKeyframe[];
	mediaFor: (e: AgentElement) => LoadedMedia | undefined;
	/** Scenes that already exist (content checks). */
	existing: TScene[];
	/** Nested scenes created while building; the caller adds them to the project. */
	created: TScene[];
};

export function compoundContentElements(content: AgentCompoundContent): AgentElement[] {
	return [...(content.main ?? []), ...(content.overlay ?? []).flatMap((track) => track.elements ?? []), ...(content.audio ?? []), ...(content.elements ?? [])];
}

/** Every element definition, including the content of compound clips (depth first). */
export function* walkAgentElements(elements: AgentElement[]): Generator<AgentElement> {
	for (const e of elements) {
		yield e;
		if (e.compound) yield* walkAgentElements(compoundContentElements(e.compound));
	}
}

export const cloneTracks = (tracks: SceneTracks): SceneTracks => {
	const copy = (track: any) => ({ ...track, elements: [...track.elements] });
	return { main: copy(tracks.main), overlay: tracks.overlay.map(copy), audio: tracks.audio.map(copy) };
};

function trackTypeForCompound(ctx: BuildContext, element: CompoundElement, requested?: AgentTrackType): AgentTrackType {
	const visual = sceneHasVisualContent({ scenes: [...ctx.existing, ...ctx.created], sceneId: element.sceneId });
	const type = requested ?? (visual ? "video" : "audio");
	if (type === "video" || (type === "audio" && !visual)) return type;
	throw new Error(type === "audio" ? "a compound clip with visual content cannot go on an audio track" : `a compound clip cannot go on a ${type} track`);
}

/**
 * Puts one element definition on a track of `tracks` (mutable copies, see cloneTracks): the track
 * named `ref.name` of the right type (Main/Utama alias), else a new one (audio appended, others
 * inserted at `ref.index`, default 0 = topmost overlay).
 */
export function placeAgentElement({ tracks, sceneId, e, ref, ctx }: {
	tracks: SceneTracks; sceneId: string; e: AgentElement; ref: AgentTrackRef; ctx: BuildContext;
}): { trackId: string; element: any } {
	let element: any = null;
	let type: AgentTrackType;
	if (e.compound) {
		element = buildAgentCompound({ e, hostSceneId: sceneId, ctx });
		type = trackTypeForCompound(ctx, element, ref.type);
	} else {
		type = ref.type ?? inferTrackType(e, ctx.mediaFor(e));
	}
	let track: any = findTrackByName(orderedTracks(tracks), ref.name, type);
	const isNew = !track;
	// A compound's own audio plays only on an unmuted track.
	if (isNew) track = createAgentTrack(type, ref.name, { muted: !e.compound });
	element ??= buildAgentElement({ e, media: ctx.mediaFor(e), trackId: track.id, sceneId, canvas: ctx.canvas, keyframes: ctx.keyframes });
	if (isNew) {
		if (type === "audio") tracks.audio.push(track);
		else tracks.overlay.splice(Math.max(0, Math.min(ref.index ?? 0, tracks.overlay.length)), 0, track);
	}
	track.elements.push(element);
	return { trackId: track.id, element };
}

/** Builds a compound clip element and its nested scene (pushed to ctx.created, nested clips first). */
export function buildAgentCompound({ e, hostSceneId, ctx }: { e: AgentElement; hostSceneId: string; ctx: BuildContext }): CompoundElement {
	const content = e.compound ?? {};
	const scene: TScene = { ...buildDefaultScene({ name: e.name, isMain: false }), kind: "compound" };
	// The main track keeps the editor's default name (same as compounds made in the UI); "Main" reaches it by alias.
	const tracks = scene.tracks;
	const place = (el: AgentElement, ref: AgentTrackRef) => placeAgentElement({ tracks, sceneId: scene.id, e: el, ref, ctx });
	for (const el of content.main ?? []) place(el, { name: "Main", type: "video" });
	for (const def of content.overlay ?? []) {
		const track = createAgentTrack(def.type, def.name, { muted: !(def.elements ?? []).some((el) => el.compound) });
		tracks.overlay.push(track);
		for (const el of def.elements ?? []) {
			if (el.compound) {
				const nested = buildAgentCompound({ e: el, hostSceneId: scene.id, ctx });
				trackTypeForCompound(ctx, nested, def.type);
				track.elements.push(nested);
			} else {
				track.elements.push(buildAgentElement({ e: el, media: ctx.mediaFor(el), trackId: track.id, sceneId: scene.id, canvas: ctx.canvas, keyframes: ctx.keyframes }));
			}
		}
	}
	for (const el of content.audio ?? []) place(el, { name: "Audio", type: "audio" });
	for (const el of content.elements ?? []) {
		if (!el.track || typeof el.track.name !== "string") throw new Error(`element ${el.agent_id ?? el.name} in compound ${e.name} needs track:{name}`);
		place(el, el.track);
	}
	if (orderedTracks(tracks).every((track) => track.elements.length === 0)) throw new Error(`compound clip ${e.name} has no content`);

	const sourceDuration = calculateTotalDuration({ tracks });
	const trimStart = secs(e.trimStart ?? 0);
	const duration = (typeof e.duration === "number" ? secs(e.duration) : Math.max(0, sourceDuration - trimStart)) as MediaTime;
	if (duration <= 0) throw new Error(`compound clip ${e.name} has no duration`);
	const element = {
		id: generateUUID(), type: "compound", name: e.name, agentId: e.agent_id, groupId: e.group, sceneId: scene.id,
		startTime: secs(e.start ?? 0), duration, trimStart, trimEnd: Math.max(0, sourceDuration - trimStart - duration) as MediaTime, sourceDuration,
		params: { ...buildDefaultParamValues(getBuiltInElementParams({ type: "compound" })), ...(e.params ?? {}) },
	} as CompoundElement;
	for (const k of e.keyframes ?? []) {
		const paths = k.path === "scale" ? ["transform.scaleX", "transform.scaleY"] : [k.path];
		for (const propertyPath of paths) ctx.keyframes.push({ sceneId: hostSceneId, trackId: "", elementId: element.id, propertyPath, time: k.time, value: k.value });
	}
	ctx.created.push(scene);
	return element;
}

/** Adds pending keyframes to their elements (found by id in their scene; unset sceneId = defaultSceneId). */
export function applyAgentKeyframes({ scenes, keyframes, defaultSceneId }: { scenes: TScene[]; keyframes: PendingKeyframe[]; defaultSceneId: string }): TScene[] {
	if (keyframes.length === 0) return scenes;
	return scenes.map((scene) => {
		const own = keyframes.filter((k) => (k.sceneId ?? defaultSceneId) === scene.id);
		if (own.length === 0) return scene;
		let tracks = scene.tracks;
		for (const k of own) {
			const track = orderedTracks(tracks).find((t) => t.elements.some((element) => element.id === k.elementId));
			if (!track) continue;
			tracks = updateElementInSceneTracks({
				tracks, trackId: track.id, elementId: k.elementId,
				update: (element) => {
					const target = resolveAnimationTarget({ element, path: k.propertyPath });
					if (!target) return element;
					const time = maxMediaTime({ a: ZERO_MEDIA_TIME, b: minMediaTime({ a: secs(k.time), b: element.duration }) });
					return {
						...element,
						animations: upsertPathKeyframe({
							animations: element.animations, propertyPath: k.propertyPath, time, value: k.value, interpolation: "linear",
							channelLayout: target.channelLayout, coerceValue: target.coerceValue,
						}),
					};
				},
			});
		}
		return { ...scene, tracks };
	});
}

