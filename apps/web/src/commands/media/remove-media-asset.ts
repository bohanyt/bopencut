import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { MediaAsset } from "@/media/types";
import { buildWaveformSourceKey } from "@/media/waveform-summary";
import { storageService } from "@/services/storage/service";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { hasMediaId } from "@/timeline/element-utils";
import type { SceneTracks, TScene, TimelineTrack } from "@/timeline";

function withoutMedia<T extends TimelineTrack>(track: T, mediaId: string): T {
	const elements = track.elements.filter(
		(element) => !(hasMediaId(element) && element.mediaId === mediaId),
	);
	return (elements.length === track.elements.length ? track : { ...track, elements }) as T;
}

export class RemoveMediaAssetCommand extends Command {
	private savedAssets: MediaAsset[] | null = null;
	/** All scenes before removal: clips using the asset are removed everywhere, compound content included. */
	private savedScenes: TScene[] | null = null;
	private removedAsset: MediaAsset | null = null;

	constructor({
		projectId,
		assetId,
	}: {
		projectId: string;
		assetId: string;
	}) {
		super();
		this.projectId = projectId;
		this.assetId = assetId;
	}

	private projectId: string;
	private assetId: string;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const assets = editor.media.getAssets();

		this.savedAssets = [...assets];
		this.savedScenes = editor.scenes.getScenes();

		this.removedAsset =
			assets.find((media) => media.id === this.assetId) ?? null;

		if (!this.removedAsset) {
			console.error("Media asset not found:", this.assetId);
			return;
		}

		if (this.removedAsset.url) {
			URL.revokeObjectURL(this.removedAsset.url);
		}
		if (this.removedAsset.thumbnailUrl) {
			URL.revokeObjectURL(this.removedAsset.thumbnailUrl);
		}

		videoCache.clearVideo({ mediaId: this.assetId });
		waveformCache.clearSource({
			sourceKey: buildWaveformSourceKey({
				kind: "media",
				id: this.assetId,
			}),
		});

		editor.media.setAssets({
			assets: assets.filter((media) => media.id !== this.assetId),
		});

		// Remove the clips here rather than through another command, so this stays one history
		// entry and its selection intent is returned below.
		let removedClips = false;
		const nextScenes = this.savedScenes.map((scene) => {
			const tracks: SceneTracks = {
				overlay: scene.tracks.overlay.map((track) => withoutMedia(track, this.assetId)),
				main: withoutMedia(scene.tracks.main, this.assetId),
				audio: scene.tracks.audio.map((track) => withoutMedia(track, this.assetId)),
			};
			const changed =
				tracks.main !== scene.tracks.main ||
				tracks.overlay.some((track, index) => track !== scene.tracks.overlay[index]) ||
				tracks.audio.some((track, index) => track !== scene.tracks.audio[index]);
			if (!changed) return scene;
			removedClips = true;
			return { ...scene, tracks };
		});
		if (removedClips) {
			editor.scenes.setScenes({ scenes: nextScenes });
			editor.timeline.updateTracks(editor.scenes.getActiveScene().tracks);
		}

		storageService
			.deleteMediaAsset({ projectId: this.projectId, id: this.assetId })
			.catch((error) => {
				console.error("Failed to delete media item:", error);
			});

		return removedClips ? createElementSelectionResult([]) : undefined;
	}

	undo(): void {
		const editor = EditorCore.getInstance();

		if (this.savedAssets && this.removedAsset) {
			const restoredAsset: MediaAsset = {
				...this.removedAsset,
				url: URL.createObjectURL(this.removedAsset.file),
			};

			editor.media.setAssets({
				assets: this.savedAssets.map((a) =>
					a.id === this.assetId ? restoredAsset : a,
				),
			});

			storageService
				.saveMediaAsset({
					projectId: this.projectId,
					mediaAsset: restoredAsset,
				})
				.catch((error) => {
					console.error("Failed to restore media item on undo:", error);
				});
		}

		if (this.savedScenes) {
			editor.scenes.setScenes({ scenes: this.savedScenes });
			editor.timeline.updateTracks(editor.scenes.getActiveScene().tracks);
		}
	}
}
