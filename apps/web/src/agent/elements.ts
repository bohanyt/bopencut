// Elemen dari agen (bundle/draf) -> elemen timeline OpenCut asli.
import { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { buildElementFromMedia, buildEffectElement, buildGraphicElement, buildTextElement } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";
import { getGraphicDefinition } from "@/graphics";
import type { ParamValues } from "@/params";
import { generateUUID } from "@/utils/id";

export type AgentAsset = { path: string; type: "image" | "video" | "audio" | "model"; name: string };
export type AgentElement = {
	agent_id?: string; name: string; start: number; duration: number; trimStart?: number;
	asset?: string | AgentAsset; model3d?: { params?: Record<string, number> }; effect?: string; effectParams?: Record<string, number>;
	graphic?: { definitionId: string; params?: ParamValues }; icon?: { name: string; color?: string; svg?: string }; text?: string; group?: string;
	params?: ParamValues; size?: [number, number];
	keyframes?: { path: string; time: number; value: number }[];
};
export type LoadedMedia = { id: string; type: AgentAsset["type"]; width?: number; height?: number; duration?: number };
export type PendingKeyframe = { trackId: string; elementId: string; propertyPath: string; time: number; value: number };

export const secs = (seconds: number) => mediaTimeFromSeconds({ seconds });

/** Ambil file dari AGENT_FILES_ROOT dan daftarkan sebagai media proyek aktif. */
export async function loadAgentAsset({ projectId, asset }: { projectId: string; asset: AgentAsset }): Promise<LoadedMedia> {
	const editor = EditorCore.getInstance();
	const res = await fetch(`/api/agent/file?p=${encodeURIComponent(asset.path)}`);
	if (!res.ok) throw new Error("Aset tidak terbaca: " + asset.path);
	const blob = await res.blob();
	const fileName = asset.path.split("/").pop() ?? asset.name;
	const [processed] = await processMediaAssets({ files: [new File([blob], fileName, { type: blob.type })] });
	if (!processed) throw new Error("Aset gagal diproses: " + asset.path);
	const saved = await editor.media.addMediaAsset({ projectId, asset: { ...processed, name: asset.name } });
	if (!saved) throw new Error("Aset gagal disimpan: " + asset.path);
	return { id: saved.id, type: asset.type === "model" ? "model" : processed.type as AgentAsset["type"], width: processed.width, height: processed.height, duration: processed.duration };
}

/** Bangun elemen OpenCut. Keyframe dikumpulkan ke `keyframes` (waktu dalam detik, relatif elemen). */
export function buildAgentElement({ e, media, trackId, canvas, keyframes }: {
	e: AgentElement; media?: LoadedMedia; trackId: string; canvas: { width: number; height: number }; keyframes: PendingKeyframe[];
}): any {
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
		if (!e.icon.svg) throw new Error("Ikon belum dimuat: " + e.icon.name);
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
	if (e.model3d && media?.type !== "model") throw new Error("Aset model tidak ada untuk " + e.name);
	if (!media) throw new Error("Aset tidak ada untuk " + e.name);
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
