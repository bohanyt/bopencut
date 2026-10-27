// Impor bundle agen (AGENT_WORKSPACE/bundle/bundle.json) menjadi proyek OpenCut biasa.
// Semua elemen tetap elemen OpenCut asli, jadi bisa digeser/trim/hapus seperti biasa.
import { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { buildElementFromMedia, buildEffectElement } from "@/timeline/element-utils";
import type { AudioTrack, EffectTrack, OverlayTrack, SceneTracks, VideoTrack } from "@/timeline/types";
import { mediaTimeFromSeconds } from "@/wasm";
import { generateUUID } from "@/utils/id";

type BundleEl = {
	agent_id?: string; name: string; start: number; duration: number; trimStart: number;
	asset?: string; effect?: string; effectParams?: Record<string, number>;
	params?: Record<string, number>; size?: [number, number];
	keyframes?: { path: string; time: number; value: number }[];
};
type Bundle = {
	name: string; width: number; height: number;
	assets: { key: string; path: string; type: "image" | "video" | "audio"; name: string }[];
	main: BundleEl[]; audio: BundleEl[];
	overlay: { name: string; type: "video" | "effect"; elements: BundleEl[] }[];
};

const secs = (seconds: number) => mediaTimeFromSeconds({ seconds });

export async function importAgentBundle({ onStatus }: { onStatus: (text: string) => void }): Promise<string> {
	const editor = EditorCore.getInstance();
	const bundle: Bundle = await (await fetch("/api/agent/bundle", { cache: "no-store" })).json();
	const projectId = await editor.project.createNewProject({ name: bundle.name });
	const media = new Map<string, { id: string; width?: number; height?: number; duration?: number }>();

	let done = 0;
	for (const a of bundle.assets) {
		onStatus(`Memuat aset ${++done}/${bundle.assets.length}: ${a.name}`);
		const blob = await (await fetch(`/api/agent/file?p=${encodeURIComponent(a.path)}`)).blob();
		const fileName = a.path.split("/").pop() ?? a.name;
		const [processed] = await processMediaAssets({ files: [new File([blob], fileName, { type: blob.type })] });
		if (!processed) throw new Error("Aset gagal diproses: " + a.path);
		const saved = await editor.media.addMediaAsset({ projectId, asset: { ...processed, name: a.name } });
		if (!saved) throw new Error("Aset gagal disimpan: " + a.path);
		media.set(a.key, { id: saved.id, width: processed.width, height: processed.height, duration: processed.duration });
	}

	onStatus("Menyusun timeline…");
	const keyframes: Parameters<typeof editor.timeline.upsertKeyframes>[0]["keyframes"] = [];
	const toElement = (e: BundleEl, trackId: string) => {
		if (e.effect) {
			const el = { ...buildEffectElement({ effectType: e.effect, startTime: secs(e.start), duration: secs(e.duration) }), id: generateUUID(), agentId: e.agent_id };
			el.name = e.name;
			el.params = { ...el.params, ...(e.effectParams ?? {}) };
			return el;
		}
		const m = media.get(e.asset as string);
		if (!m) throw new Error("Aset tidak ada untuk " + e.name);
		const type = bundle.assets.find((a) => a.key === e.asset)?.type ?? "image";
		const el: any = { ...buildElementFromMedia({ mediaId: m.id, mediaType: type, name: e.name, duration: secs(e.duration), startTime: secs(e.start) }), id: generateUUID(), agentId: e.agent_id };
		if (type !== "image" && m.duration) {
			el.sourceDuration = secs(m.duration);
			el.trimStart = secs(e.trimStart);
			el.trimEnd = secs(Math.max(0, m.duration - e.trimStart - e.duration));
		}
		if (type === "video") el.isSourceAudioEnabled = false;
		let base = 1;
		if (e.size && m.width && m.height) {
			const contain = Math.min(bundle.width / m.width, bundle.height / m.height);
			base = e.size[0] / (m.width * contain);
			el.params["transform.scaleX"] = base;
			el.params["transform.scaleY"] = base;
		}
		for (const [k, v] of Object.entries(e.params ?? {})) el.params[k] = v;
		for (const k of e.keyframes ?? []) {
			const paths = k.path === "scale" ? ["transform.scaleX", "transform.scaleY"] : [k.path];
			for (const propertyPath of paths)
				keyframes.push({ trackId, elementId: el.id, propertyPath, time: secs(k.time), value: k.path === "scale" ? k.value * base : k.value, interpolation: "linear" });
		}
		return el;
	};

	const mainId = generateUUID();
	const tracks: SceneTracks = {
		main: { id: mainId, name: "Adegan", type: "video", muted: false, hidden: false, elements: bundle.main.map((e) => toElement(e, mainId)) } as VideoTrack,
		overlay: bundle.overlay.map((t) => {
			const id = generateUUID();
			return t.type === "effect"
				? ({ id, name: t.name, type: "effect", hidden: false, elements: t.elements.map((e) => toElement(e, id)) } as EffectTrack)
				: ({ id, name: t.name, type: "video", muted: true, hidden: false, elements: t.elements.map((e) => toElement(e, id)) } as VideoTrack);
		}) as OverlayTrack[],
		audio: [(() => { const id = generateUUID(); return { id, name: "VO", type: "audio", muted: false, elements: bundle.audio.map((e) => toElement(e, id)) } as AudioTrack; })()],
	};
	editor.timeline.updateTracks(tracks);
	editor.timeline.upsertKeyframes({ keyframes });
	await editor.project.saveCurrentProject();
	onStatus(`Selesai · ${bundle.assets.length} aset · membuka editor…`);
	return projectId;
}
