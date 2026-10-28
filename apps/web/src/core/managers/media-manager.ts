import type { EditorCore } from "@/core";
import { toast } from "sonner";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { BatchCommand, RemoveMediaAssetCommand } from "@/commands";

export class MediaManager {
	private assets: MediaAsset[] = [];
	private isLoading = false;
	/** Bumped by every load and clear: a load that is no longer the latest never writes its result. */
	private loadGeneration = 0;
	private loadController: AbortController | null = null;
	/** Project whose stored media are fully in `assets` (null while loading or after a clear). */
	private loadedProjectId: string | null = null;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	/**
	 * `ratchetFps: false` keeps the project frame rate when the media has a higher one (agent
	 * imports: the bundle or the project decides the frame rate, not the footage).
	 */
	async addMediaAsset({
		projectId,
		asset,
		ratchetFps = true,
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id">;
		ratchetFps?: boolean;
	}): Promise<MediaAsset | null> {
		const newAsset: MediaAsset = {
			...asset,
			id: generateUUID(),
		};

		this.assets = [...this.assets, newAsset];
		this.notify();

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: newAsset });
			if (ratchetFps)
				this.editor.project.ratchetFpsForImportedMedia({
					importedAssets: [newAsset],
				});
			return newAsset;
		} catch (error) {
			console.error("Failed to save media asset:", error);
			this.assets = this.assets.filter((asset) => asset.id !== newAsset.id);
			this.notify();

			if (storageService.isQuotaExceededError({ error })) {
				toast.error("Not enough browser storage", {
					description: error instanceof Error ? error.message : undefined,
				});
			} else {
				toast.error("Failed to save media", { description: error instanceof Error ? error.message : undefined });
			}

			return null;
		}
	}

	removeMediaAsset({ projectId, id }: { projectId: string; id: string }): void {
		this.removeMediaAssets({ projectId, ids: [id] });
	}

	removeMediaAssets({
		projectId,
		ids,
	}: {
		projectId: string;
		ids: string[];
	}): void {
		const uniqueIds = [...new Set(ids)];
		if (uniqueIds.length === 0) {
			return;
		}

		const command =
			uniqueIds.length === 1
				? new RemoveMediaAssetCommand({
						projectId,
						assetId: uniqueIds[0],
					})
				: new BatchCommand(
						uniqueIds.map((id) =>
							new RemoveMediaAssetCommand({
								projectId,
								assetId: id,
							}),
						),
					);

		this.editor.command.execute({ command });
	}

	/**
	 * Loads a project's stored media. Assets added while loading (an import, an agent draft) are
	 * kept: the stored list is merged in front of them. A load superseded by a newer load or a clear
	 * (switching projects) is cancelled and never overwrites the newer assets.
	 */
	async loadProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		const generation = ++this.loadGeneration;
		this.loadController?.abort();
		const controller = new AbortController();
		this.loadController = controller;
		this.loadedProjectId = null;
		this.isLoading = true;
		this.notify();

		// Large projects take a while: show progress so the editor does not look frozen.
		const toastId = `load-media-${projectId}`;
		let lastToast = 0;
		try {
			const mediaAssets = await storageService.loadAllMediaAssets({
				projectId,
				signal: controller.signal,
				onProgress: ({ loaded, total }) => {
					// At most ~4 updates a second: re-rendering the toast for every file slows the load itself.
					const now = Date.now();
					if (total < 20 || generation !== this.loadGeneration || (now - lastToast < 250 && loaded < total)) return;
					lastToast = now;
					toast.loading(`Loading media ${loaded}/${total}`, { id: toastId });
				},
			});
			if (generation !== this.loadGeneration) return;
			const stored = new Set(mediaAssets.map((asset) => asset.id));
			this.assets = [
				...mediaAssets,
				...this.assets.filter((asset) => !stored.has(asset.id)),
			];
			this.loadedProjectId = projectId;
		} catch (error) {
			if (generation === this.loadGeneration)
				console.error("Failed to load media assets:", error);
		} finally {
			toast.dismiss(toastId);
			if (generation === this.loadGeneration) {
				this.isLoading = false;
				this.loadController = null;
				this.notify();
			}
		}
	}

	/** A project created empty in this session has all its media loaded. */
	markProjectMediaLoaded({ projectId }: { projectId: string }): void {
		this.loadedProjectId = projectId;
		this.notify();
	}

	/** True once the project's stored media are loaded (and no newer load is running). */
	isProjectMediaLoaded({ projectId }: { projectId: string }): boolean {
		return !this.isLoading && this.loadedProjectId === projectId;
	}

	/**
	 * Removes assets outside history and deletes them from storage, e.g. media imported for an
	 * agent draft that was then not applied.
	 */
	async discardMediaAssets({ projectId, ids }: { projectId: string; ids: string[] }): Promise<void> {
		const drop = new Set(ids);
		if (drop.size === 0) return;
		for (const asset of this.assets) {
			if (!drop.has(asset.id)) continue;
			if (asset.url?.startsWith("blob:")) URL.revokeObjectURL(asset.url);
			if (asset.thumbnailUrl?.startsWith("blob:")) URL.revokeObjectURL(asset.thumbnailUrl);
		}
		this.assets = this.assets.filter((asset) => !drop.has(asset.id));
		this.notify();
		await Promise.all(
			[...drop].map((id) =>
				storageService.deleteMediaAsset({ projectId, id }).catch((error) => {
					console.error("Failed to delete discarded media:", id, error);
				}),
			),
		);
	}

	async clearProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		waveformCache.clearAll();

		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
		});

		const mediaIds = this.assets.map((asset) => asset.id);
		this.assets = [];
		this.notify();

		try {
			await Promise.all(
				mediaIds.map((id) =>
					storageService.deleteMediaAsset({ projectId, id }),
				),
			);
		} catch (error) {
			console.error("Failed to clear media assets from storage:", error);
		}
	}

	clearAllAssets(): void {
		this.loadGeneration++;
		this.loadController?.abort();
		this.loadController = null;
		this.loadedProjectId = null;
		this.isLoading = false;
		videoCache.clearAll();
		waveformCache.clearAll();

		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
		});

		this.assets = [];
		this.notify();
	}

	getAssets(): MediaAsset[] {
		return this.assets;
	}

	setAssets({ assets }: { assets: MediaAsset[] }): void {
		this.assets = assets;
		this.notify();
	}

	isLoadingMedia(): boolean {
		return this.isLoading;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
