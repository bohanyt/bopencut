// Impor bundle agen (AGENT_WORKSPACE/bundle/bundle.json) menjadi proyek OpenCut biasa.
// Semua elemen tetap elemen OpenCut asli, jadi bisa digeser/trim/hapus seperti biasa.
import { EditorCore } from "@/core";
import type { AudioTrack, EffectTrack, GraphicTrack, TextTrack, OverlayTrack, SceneTracks, VideoTrack } from "@/timeline/types";
import { loadIcon } from "@/stickers/providers/iconify";
import { generateUUID } from "@/utils/id";
import { type AgentAsset, type AgentElement, type LoadedMedia, type PendingKeyframe, buildAgentElement, loadAgentAsset, secs } from "./elements";

type Bundle = {
	name: string; width: number; height: number;
	assets: (AgentAsset & { key: string })[];
	main: AgentElement[]; audio: AgentElement[];
	overlay: { name: string; type: "video" | "effect" | "graphic" | "text"; elements: AgentElement[] }[];
};

export async function importAgentBundle({ onStatus }: { onStatus: (text: string) => void }): Promise<string> {
	const editor = EditorCore.getInstance();
	const bundle: Bundle = await (await fetch("/api/agent/bundle", { cache: "no-store" })).json();
	const projectId = await editor.project.createNewProject({ name: bundle.name });
	const media = new Map<string, LoadedMedia>();

	let done = 0;
	for (const a of bundle.assets) {
		onStatus(`Memuat aset ${++done}/${bundle.assets.length}: ${a.name}`);
		media.set(a.key, await loadAgentAsset({ projectId, asset: a }));
	}

	for (const e of [...bundle.main, ...bundle.audio, ...bundle.overlay.flatMap((t) => t.elements)]) {
		if (e.icon) e.icon.svg = await loadIcon(e.icon.name);
	}

	onStatus("Menyusun timeline…");
	const canvas = { width: bundle.width, height: bundle.height };
	const keyframes: PendingKeyframe[] = [];
	const build = (e: AgentElement, trackId: string) => buildAgentElement({ e, media: e.asset ? media.get(e.asset as string) : undefined, trackId, canvas, keyframes });

	const mainId = generateUUID();
	const audioId = generateUUID();
	const tracks: SceneTracks = {
		main: { id: mainId, name: "Utama", type: "video", muted: false, hidden: false, elements: bundle.main.map((e) => build(e, mainId)) } as VideoTrack,
		overlay: bundle.overlay.map((t) => {
			const id = generateUUID();
			return t.type === "effect"
				? ({ id, name: t.name, type: "effect", hidden: false, elements: t.elements.map((e) => build(e, id)) } as EffectTrack)
				: t.type === "text"
					? ({ id, name: t.name, type: "text", hidden: false, elements: t.elements.map((e) => build(e, id)) } as TextTrack)
					: t.type === "graphic"
					? ({ id, name: t.name, type: "graphic", hidden: false, elements: t.elements.map((e) => build(e, id)) } as GraphicTrack)
					: ({ id, name: t.name, type: "video", muted: true, hidden: false, elements: t.elements.map((e) => build(e, id)) } as VideoTrack);
		}) as OverlayTrack[],
		audio: [{ id: audioId, name: "Audio", type: "audio", muted: false, elements: bundle.audio.map((e) => build(e, audioId)) } as AudioTrack],
	};
	editor.timeline.updateTracks(tracks);
	editor.timeline.upsertKeyframes({ keyframes: keyframes.map((k) => ({ ...k, time: secs(k.time), interpolation: "linear" as const })) });
	await editor.project.saveCurrentProject();
	onStatus(`Selesai · ${bundle.assets.length} aset · membuka editor…`);
	return projectId;
}
