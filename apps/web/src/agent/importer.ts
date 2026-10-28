// Import an agent bundle (AGENT_WORKSPACE/bundle/bundle.json) as a normal OpenCut project.
// All elements remain native OpenCut elements and can be moved, trimmed, or deleted as usual.
// An element with `compound:{main?,overlay?,audio?,elements?}` becomes a compound clip whose
// nested tracks are built the same way (times relative to the clip's content).
import { storageService } from "@/services/storage/service";
import { processMediaAssets } from "@/media/processing";
import { buildDefaultScene, getProjectDurationFromScenes } from "@/timeline/scenes";
import { CURRENT_PROJECT_VERSION } from "@/services/storage/migrations";
import { DEFAULT_FPS } from "@/fps/defaults";
import { getRaisedProjectFpsForImportedMedia } from "@/fps/utils";
import { DEFAULT_BACKGROUND_COLOR } from "@/background/color";
import { validateProjectFont, type ProjectFont } from "@/fonts/project-fonts";
import { validateBundle } from "./bundle-schema";
import type { AudioTrack, OverlayTrack, SceneTracks, TScene, VideoTrack } from "@/timeline";
import { relocateVisualCompounds, syncCompoundDurations } from "@/timeline/compound";
import { loadIcon } from "@/stickers/providers/iconify";
import { generateUUID } from "@/utils/id";
import { type AgentAsset, type AgentElement, type LoadedMedia, type AgentTrackType, buildAgentElement, createAgentTrack, inferTrackType } from "./elements";
import { type BuildContext, applyAgentKeyframes, buildAgentCompound, walkAgentElements } from "./compound-content";

export type Bundle = {
	fonts?: { family: string; path: string; weight?: string; style?: string }[];
	name: string; width: number; height: number;
	assets: (AgentAsset & { key: string })[];
	main: AgentElement[]; audio: AgentElement[];
	overlay: { name: string; type: "video" | "effect" | "graphic" | "text"; elements: AgentElement[] }[];
};

/** Root tracks and nested compound scenes of a bundle (pure, given its loaded media). */
export function buildBundleScenes({ bundle, media, sceneId }: { bundle: Bundle; media: Map<string, LoadedMedia>; sceneId: string }): { tracks: SceneTracks; scenes: TScene[] } {
	const ctx: BuildContext = {
		canvas: { width: bundle.width, height: bundle.height }, keyframes: [], created: [], existing: [],
		mediaFor: (e) => (typeof e.asset === "string" ? media.get(e.asset) : e.asset ? media.get(e.asset.path) : undefined),
	};
	const build = (e: AgentElement, trackId: string, type: AgentTrackType) => {
		if (!e.compound) {
			const source = ctx.mediaFor(e);
			if (inferTrackType(e, source) !== type) throw new Error(`Element ${e.name} cannot go on a ${type} track`);
			return buildAgentElement({ e, media: source, trackId, sceneId, canvas: ctx.canvas, keyframes: ctx.keyframes });
		}
		if (type !== "video" && type !== "audio") throw new Error(`compound clip ${e.name} must be on the main, a video overlay, or the audio track`);
		return buildAgentCompound({ e, hostSceneId: sceneId, ctx });
	};
	const mainId = generateUUID();
	const audioId = generateUUID();
	const tracks: SceneTracks = {
		main: { id: mainId, name: "Main", type: "video", muted: false, hidden: false, elements: (bundle.main ?? []).map((e) => build(e, mainId, "video")) } as VideoTrack,
		overlay: (bundle.overlay ?? []).map((t) => {
			// A compound's own audio plays only on an unmuted track.
			const track = createAgentTrack(t.type, t.name, { muted: !(t.elements ?? []).some((e) => e.compound) });
			track.elements = (t.elements ?? []).map((e) => build(e, track.id, t.type));
			return track;
		}) as OverlayTrack[],
		audio: [{ id: audioId, name: "Audio", type: "audio", muted: false, elements: (bundle.audio ?? []).map((e) => build(e, audioId, "audio")) } as AudioTrack],
	};
	const scenes = applyAgentKeyframes({ scenes: ctx.created, keyframes: ctx.keyframes, defaultSceneId: sceneId });
	const [host] = applyAgentKeyframes({ scenes: [{ id: sceneId, tracks } as TScene], keyframes: ctx.keyframes, defaultSceneId: sceneId });
	return { tracks: host.tracks, scenes };
}

export type ImportAssetResult = { key: string; path: string; ok: boolean; mediaId?: string; error?: string };
export class BundleImportError extends Error {
	constructor(message: string, readonly assets: ImportAssetResult[]) { super(message); }
}

type ImportDependencies = {
	storage: Pick<typeof storageService, "saveProject" | "saveMediaAsset" | "deleteProject" | "deleteProjectMedia">;
	process: typeof processMediaAssets;
	request: (url: string) => Promise<Response>;
};
async function fetchFile(path: string, request: ImportDependencies["request"]) {
	const response = await request(`/api/agent/file?p=${encodeURIComponent(path)}`);
	if (!response.ok) throw new Error(`Cannot read bundle file: ${path}`);
	const bytes = await response.arrayBuffer();
	return new File([bytes], path.split(/[\\/]/).pop() ?? "asset", { type: response.headers.get("Content-Type") ?? "application/octet-stream" });
}

/** Save the project last. Nothing changes the active editor, even when an import fails. */
export async function importAgentBundle({ onStatus, bundlePath = "bundle/bundle.json", name, onAsset = () => {} }: {
	onStatus: (text: string) => void; bundlePath?: string; name?: string; onAsset?: (result: ImportAssetResult) => void;
}, dependencies: ImportDependencies = { storage: storageService, process: processMediaAssets, request: (url) => fetch(url, { cache: "no-store" }) }): Promise<string> {
	const response = await dependencies.request(`/api/agent/bundle?bundlePath=${encodeURIComponent(bundlePath)}`);
	const body = await response.json();
	if (!response.ok) throw new BundleImportError(body.error ?? "Invalid bundle", body.assets ?? []);
	const bundle = validateBundle(body);
	const projectId = generateUUID();
	const media = new Map<string, LoadedMedia>();
	const results: ImportAssetResult[] = [];
	const urls: string[] = [];
	let fps = DEFAULT_FPS;
	try {
		const elements = [...walkAgentElements([...(bundle.main ?? []), ...(bundle.audio ?? []), ...(bundle.overlay ?? []).flatMap((t) => t.elements)])];
		const assets = [...bundle.assets, ...elements.flatMap((e) => e.asset && typeof e.asset !== "string" ? [{ ...e.asset, key: e.asset.path }] : [])];
		for (const a of assets) {
			if (media.has(a.key)) continue;
			onStatus(`Loading asset ${results.length + 1}/${assets.length}: ${a.name}`);
			try {
				const [processed] = await dependencies.process({ files: [await fetchFile(a.path, dependencies.request)] });
				if (!processed) throw new Error("Asset could not be decoded");
				fps = getRaisedProjectFpsForImportedMedia({ currentFps: fps, importedAssets: [processed] }) ?? fps;
				if (processed.url?.startsWith("blob:")) urls.push(processed.url);
				const id = generateUUID();
				await dependencies.storage.saveMediaAsset({ projectId, mediaAsset: { ...processed, id, name: a.name } });
				media.set(a.key, { id, type: a.type === "model" ? "model" : processed.type, width: processed.width, height: processed.height, duration: processed.duration });
				const result = { key: a.key, path: a.path, ok: true, mediaId: id };
				results.push(result); onAsset(result);
			} catch (error) {
				const result = { key: a.key, path: a.path, ok: false, error: String(error) };
				results.push(result); onAsset(result); throw error;
			}
		}
		const fonts: ProjectFont[] = [];
		for (const font of bundle.fonts ?? []) {
			try {
				const file = await fetchFile(font.path, dependencies.request);
				const dataUrl = await new Promise<string>((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => resolve(String(reader.result));
					reader.onerror = () => reject(reader.error);
					reader.readAsDataURL(file);
				});
				const stored = { family: font.family, weight: font.weight, style: font.style, dataUrl };
				await validateProjectFont(stored);
				fonts.push(stored);
				const result = { key: `font:${font.family}`, path: font.path, ok: true };
				results.push(result); onAsset(result);
			} catch (error) {
				const result = { key: `font:${font.family}`, path: font.path, ok: false, error: String(error) };
				results.push(result); onAsset(result); throw error;
			}
		}
		for (const e of elements) if (e.icon && !e.icon.svg) e.icon.svg = await loadIcon(e.icon.name);
		onStatus("Building timeline...");
		const main = buildDefaultScene({ name: "Main scene", isMain: true });
		const built = buildBundleScenes({ bundle, media, sceneId: main.id });
		const scenes = syncCompoundDurations(relocateVisualCompounds([{ ...main, tracks: built.tracks }, ...built.scenes]));
		await dependencies.storage.saveProject({ project: {
			metadata: { id: projectId, name: name ?? bundle.name, duration: getProjectDurationFromScenes({ scenes }), createdAt: new Date(), updatedAt: new Date() },
			scenes, currentSceneId: main.id, version: CURRENT_PROJECT_VERSION,
			settings: { fps, canvasSize: { width: bundle.width, height: bundle.height }, canvasSizeMode: "custom", background: { type: "color", color: DEFAULT_BACKGROUND_COLOR }, fonts },
		} });
		onStatus(`Done: ${results.length} assets`);
		return projectId;
	} catch (error) {
		try {
			await dependencies.storage.deleteProjectMedia({ projectId });
			await dependencies.storage.deleteProject({ id: projectId });
		} catch (cleanup) { throw new BundleImportError(`${String(error)}; cleanup failed for ${projectId}: ${String(cleanup)}`, results); }
		throw new BundleImportError(String(error), results);
	} finally { urls.forEach((url) => URL.revokeObjectURL(url)); }
}
