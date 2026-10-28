// Import an agent bundle (AGENT_WORKSPACE/bundle/bundle.json) as a normal OpenCut project.
// All elements remain native OpenCut elements and can be moved, trimmed, or deleted as usual.
// An element with `compound:{main?,overlay?,audio?,elements?}` becomes a compound clip whose
// nested tracks are built the same way (times relative to the clip's content).
import { EditorCore } from "@/core";
import type { AudioTrack, OverlayTrack, SceneTracks, TScene, VideoTrack } from "@/timeline";
import { relocateVisualCompounds, syncCompoundDurations } from "@/timeline/compound";
import { loadIcon } from "@/stickers/providers/iconify";
import { generateUUID } from "@/utils/id";
import { type AgentAsset, type AgentElement, type LoadedMedia, buildAgentElement, createAgentTrack, loadAgentAsset } from "./elements";
import { type BuildContext, applyAgentKeyframes, buildAgentCompound, walkAgentElements } from "./compound-content";
import { loadTextPresets } from "@/text/presets";
import { resolveCaptionPreset } from "./captions";

export type Bundle = {
	name: string; width: number; height: number;
	assets: (AgentAsset & { key: string })[];
	main: AgentElement[]; audio: AgentElement[];
	overlay: { name: string; type: "video" | "effect" | "graphic" | "text"; elements: AgentElement[] }[];
};

/** Root tracks and nested compound scenes of a bundle (pure, given its loaded media). */
export function buildBundleScenes({ bundle, media, sceneId }: { bundle: Bundle; media: Map<string, LoadedMedia>; sceneId: string }): { tracks: SceneTracks; scenes: TScene[] } {
	const ctx: BuildContext = {
		canvas: { width: bundle.width, height: bundle.height }, keyframes: [], created: [], existing: [],
		mediaFor: (e) => (typeof e.asset === "string" ? media.get(e.asset) : undefined),
	};
	const build = (e: AgentElement, trackId: string, allowed: "video" | "audio" | null) => {
		if (!e.compound) return buildAgentElement({ e, media: ctx.mediaFor(e), trackId, sceneId, canvas: ctx.canvas, keyframes: ctx.keyframes });
		if (!allowed) throw new Error(`compound clip ${e.name} must be on the main, a video overlay, or the audio track`);
		return buildAgentCompound({ e, hostSceneId: sceneId, ctx });
	};
	const overlayAllows = (type: Bundle["overlay"][number]["type"]) => (type === "video" ? "video" : null);
	const mainId = generateUUID();
	const audioId = generateUUID();
	const tracks: SceneTracks = {
		main: { id: mainId, name: "Main", type: "video", muted: false, hidden: false, elements: (bundle.main ?? []).map((e) => build(e, mainId, "video")) } as VideoTrack,
		overlay: (bundle.overlay ?? []).map((t) => {
			// A compound's own audio plays only on an unmuted track.
			const track = createAgentTrack(t.type, t.name, { muted: !(t.elements ?? []).some((e) => e.compound) });
			track.elements = (t.elements ?? []).map((e) => build(e, track.id, overlayAllows(t.type)));
			return track;
		}) as OverlayTrack[],
		audio: [{ id: audioId, name: "Audio", type: "audio", muted: false, elements: (bundle.audio ?? []).map((e) => build(e, audioId, "audio")) } as AudioTrack],
	};
	const scenes = applyAgentKeyframes({ scenes: ctx.created, keyframes: ctx.keyframes, defaultSceneId: sceneId });
	const [host] = applyAgentKeyframes({ scenes: [{ id: sceneId, tracks } as TScene], keyframes: ctx.keyframes, defaultSceneId: sceneId });
	return { tracks: host.tracks, scenes };
}

export async function importAgentBundle({ onStatus }: { onStatus: (text: string) => void }): Promise<string> {
	const editor = EditorCore.getInstance();
	const bundle: Bundle = await (await fetch("/api/agent/bundle", { cache: "no-store" })).json();
	const projectId = await editor.project.createNewProject({ name: bundle.name });
	const media = new Map<string, LoadedMedia>();

	let done = 0;
	for (const a of bundle.assets) {
		onStatus(`Loading asset ${++done}/${bundle.assets.length}: ${a.name}`);
		media.set(a.key, await loadAgentAsset({ projectId, asset: a }));
	}

	let presets: ReturnType<typeof loadTextPresets> | undefined;
	for (const e of walkAgentElements([...(bundle.main ?? []), ...(bundle.audio ?? []), ...(bundle.overlay ?? []).flatMap((t) => t.elements ?? [])])) {
		if (e.caption?.preset) e.caption = resolveCaptionPreset(e.caption, await (presets ??= loadTextPresets()));
		if (e.icon) e.icon.svg = await loadIcon(e.icon.name);
	}

	onStatus("Building timeline…");
	const main = editor.scenes.getActiveScene();
	const built = buildBundleScenes({ bundle, media, sceneId: main.id });
	const scenes = syncCompoundDurations(relocateVisualCompounds([
		...editor.scenes.getScenes().map((scene) => (scene.id === main.id ? { ...scene, tracks: built.tracks } : scene)),
		...built.scenes,
	]));
	editor.scenes.setScenes({ scenes, activeSceneId: main.id });
	editor.timeline.updateTracks(editor.scenes.getActiveScene().tracks);
	await editor.project.saveCurrentProject();
	onStatus(`Done · ${bundle.assets.length} assets · opening editor…`);
	return projectId;
}
