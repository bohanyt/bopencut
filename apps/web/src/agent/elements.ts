// Agent elements (bundle/draft) -> native OpenCut timeline elements.
import { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { buildElementFromMedia, buildEffectElement, buildGraphicElement, buildTextElement } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import { getGraphicDefinition } from "@/graphics";
import type { ParamValues } from "@/params";
import { generateUUID } from "@/utils/id";
import { buildAgentCaption, type AgentCaption } from "./captions";

export type AgentAsset = { path: string; type: "image" | "video" | "audio" | "model"; name: string };
export type AgentElement = {
	agent_id?: string; name: string; start: number; duration: number; trimStart?: number;
	asset?: string | AgentAsset; model3d?: { params?: Record<string, number> }; effect?: string; effectParams?: Record<string, number>;
	graphic?: { definitionId: string; params?: ParamValues }; icon?: { name: string; color?: string; svg?: string }; text?: string; group?: string;
	params?: ParamValues; size?: [number, number];
	caption?: AgentCaption;
	keyframes?: { path: string; time: number; value: number }[];
	/** Makes this element a compound clip holding these nested tracks (times relative to the clip's content). */
	compound?: AgentCompoundContent;
};
export type AgentTrackType = "video" | "audio" | "effect" | "graphic" | "text";
/** Where an element goes: a track by name (Main/Utama alias), created at `index` (0 = topmost overlay) if missing. */
export type AgentTrackRef = { name: string; type?: AgentTrackType; index?: number };
/**
 * Nested tracks of a compound clip, bundle style (`main`, `overlay` with index 0 = topmost, `audio`)
 * and/or draft style (`elements`, each with its own `track`, placed like a draft `add`).
 */
export type AgentCompoundContent = {
	main?: AgentElement[];
	overlay?: { name: string; type: "video" | "effect" | "graphic" | "text"; elements: AgentElement[] }[];
	audio?: AgentElement[];
	elements?: (AgentElement & { track: AgentTrackRef })[];
};
export type LoadedMedia = { id: string; type: AgentAsset["type"]; width?: number; height?: number; duration?: number };
/** Keyframe to add once the element is placed; time in seconds, relative to the element. */
export type PendingKeyframe = { sceneId?: string; trackId: string; elementId: string; propertyPath: string; time: number; value: number };

export const secs = (seconds: number) => mediaTimeFromSeconds({ seconds });

/** Fetch a file from AGENT_FILES_ROOT and register it as media in the active project. */
export async function loadAgentAsset({ projectId, asset }: { projectId: string; asset: AgentAsset }): Promise<LoadedMedia> {
	const editor = EditorCore.getInstance();
	const res = await fetch(`/api/agent/file?p=${encodeURIComponent(asset.path)}`);
	if (!res.ok) throw new Error("Cannot read asset: " + asset.path);
	const blob = await res.blob();
	const fileName = asset.path.split("/").pop() ?? asset.name;
	const [processed] = await processMediaAssets({ files: [new File([blob], fileName, { type: blob.type })] });
	if (!processed) throw new Error("Failed to process asset: " + asset.path);
	const saved = await editor.media.addMediaAsset({ projectId, asset: { ...processed, name: asset.name } });
	if (!saved) throw new Error("Failed to save asset: " + asset.path);
	return { id: saved.id, type: asset.type === "model" ? "model" : processed.type as AgentAsset["type"], width: processed.width, height: processed.height, duration: processed.duration };
}

/** Track type an element goes on when the draft or bundle does not say. */
export function inferTrackType(e: AgentElement, media?: LoadedMedia): AgentTrackType {
	if (e.caption) return "text";
	return media?.type === "audio" ? "audio" : e.effect ? "effect" : (e.graphic || e.icon) ? "graphic" : e.text !== undefined ? "text" : "video";
}

/** Empty agent track. Video tracks for footage are muted (source audio stays off); compound hosts pass muted: false. */
export function createAgentTrack(type: AgentTrackType, name: string, { muted = true }: { muted?: boolean } = {}): any {
	if (type === "audio") return { id: generateUUID(), name, type, muted: false, elements: [] };
	if (type === "effect") return { id: generateUUID(), name, type, hidden: false, elements: [] };
	if (type === "graphic" || type === "text") return { id: generateUUID(), name, type, hidden: false, elements: [] };
	return { id: generateUUID(), name, type, muted, hidden: false, elements: [] };
}

/**
 * Build an OpenCut element (not a compound clip; see buildAgentNode). Keyframes are collected in
 * `keyframes`, tagged with `sceneId` when given.
 */
export function buildAgentElement({ e, media, trackId, sceneId, canvas, keyframes: collected }: {
	e: AgentElement; media?: LoadedMedia; trackId: string; sceneId?: string; canvas: { width: number; height: number }; keyframes: PendingKeyframe[];
}): any {
	const keyframes = { push: (k: PendingKeyframe) => collected.push(sceneId ? { ...k, sceneId } : k) };
	if (e.caption) return buildAgentCaption({ e, trackId, sceneId, canvas, keyframes: collected });
	if (e.effect) {
		const el: any = { ...buildEffectElement({ effectType: e.effect, startTime: secs(e.start), duration: secs(e.duration) }), id: generateUUID(), agentId: e.agent_id };
		el.name = e.name;
		el.params = { ...el.params, ...(e.effectParams ?? {}) };
		return el;
	}
	if (e.text !== undefined) {
		const el: any = { ...buildTextElement({ raw: { name: e.name, params: { content: e.text } }, startTime: secs(e.start) }), id: generateUUID(), agentId: e.agent_id, groupId: e.group, duration: secs(e.duration) };
		Object.assign(el.params, e.params ?? {});
		for (const k of e.keyframes ?? []) {
			const paths = k.path === "scale" ? ["transform.scaleX", "transform.scaleY"] : [k.path];
			for (const propertyPath of paths) keyframes.push({ trackId, elementId: el.id, propertyPath, time: k.time, value: k.value });
		}
		return el;
	}
	if (e.icon) {
		if (!e.icon.svg) throw new Error("Icon not loaded: " + e.icon.name);
		e = { ...e, graphic: { definitionId: "icon", params: { iconName: e.icon.name, color: e.icon.color ?? "#ffffff", svg: e.icon.svg } } };
	}
	if (e.graphic) {
		const definition = getGraphicDefinition({ definitionId: e.graphic.definitionId });
		const el: any = { ...buildGraphicElement({ definitionId: e.graphic.definitionId, name: e.name, startTime: secs(e.start), params: e.graphic.params }), id: generateUUID(), agentId: e.agent_id, groupId: e.group, duration: secs(e.duration) };
		if (e.size) {
			const baseSize = Math.min(canvas.width, canvas.height);
			el.params["transform.scaleX"] = e.size[0] / baseSize;
			el.params["transform.scaleY"] = e.size[1] / baseSize;
		}
		Object.assign(el.params, e.params ?? {});
		for (const k of e.keyframes ?? []) {
			const paths = k.path === "scale" ? ["transform.scaleX", "transform.scaleY"] : [definition.params.some((p) => p.key === k.path) ? `params.${k.path}` : k.path];
			for (const propertyPath of paths) keyframes.push({ trackId, elementId: el.id, propertyPath, time: k.time, value: k.path === "scale" ? k.value * (el.params[propertyPath] as number) : k.value });
		}
		return el;
	}
	if (e.model3d && media?.type !== "model") throw new Error("Model asset missing for " + e.name);
	if (!media) throw new Error("Asset missing for " + e.name);
	const el: any = { ...buildElementFromMedia({ mediaId: media.id, mediaType: media.type === "model" ? "image" : media.type, name: e.name, duration: secs(e.duration), startTime: secs(e.start) }), id: generateUUID(), agentId: e.agent_id, groupId: e.group };
	if (e.model3d) Object.assign(el.params, e.model3d.params ?? {});
	const trimStart = e.trimStart ?? 0;
	if (media.type !== "image" && media.duration) {
		el.sourceDuration = secs(media.duration);
		el.trimStart = secs(trimStart);
		el.trimEnd = secs(Math.max(0, media.duration - trimStart - e.duration));
	}
	if (media.type === "video") el.isSourceAudioEnabled = false;
	let base = 1;
	if (e.size && media.width && media.height) {
		const contain = Math.min(canvas.width / media.width, canvas.height / media.height);
		base = e.size[0] / (media.width * contain);
		el.params["transform.scaleX"] = base;
		el.params["transform.scaleY"] = base;
	}
	for (const [k, v] of Object.entries(e.params ?? {})) el.params[k] = v;
	for (const k of e.keyframes ?? []) {
		const paths = k.path === "scale" ? ["transform.scaleX", "transform.scaleY"] : [k.path];
		for (const propertyPath of paths) keyframes.push({ trackId, elementId: el.id, propertyPath, time: k.time, value: k.path === "scale" ? k.value * base : k.value });
	}
	return el;
}
