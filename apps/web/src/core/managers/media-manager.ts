import type { EditorCore } from "@/core";
import { toast } from "sonner";
import type { MediaAsset } from "@/media/types";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { videoCache } from "@/services/video-cache/service";
import { waveformCache } from "@/services/waveform-cache/service";
import { BatchCommand, RemoveMediaAssetCommand } from "@/commands";

/** A stored media file that could not be read when the project loaded. */
export type MediaLoadFailure = { id: string; name: string; error: string };
/** Outcome of discarding staged imports: ids removed from storage, and those that could not be. */
export type DiscardResult = { removed: string[]; failed: { id: string; error: string }[] };

export class MediaManager {
	private assets: MediaAsset[] = [];
	private isLoading = false;
	/** Bumped by every load and clear: a load that is no longer the latest never writes its result. */
	private loadGeneration = 0;
	private loadController: AbortController | null = null;
	/** Project whose stored media are fully in `assets` (null while loading or after a clear). */
	private loadedProjectId: string | null = null;
	/** Stored media of the loaded project that could not be read (see retryMissingMedia). */
	private missing: MediaLoadFailure[] = [];
	/**
	 * Imports saved to storage but not published to `assets` yet (agent drafts before they commit).
	 * Nothing can use them, so discarding them can never break a clip or a history entry.
	 */
	private staged = new Map<string, { projectId: string; asset: MediaAsset }>();
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
		this.missing = [];
		this.isLoading = true;
		this.notify();
		const missing: MediaLoadFailure[] = [];

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
				onFailed: (failure) => missing.push(failure),
			});
			if (generation !== this.loadGeneration) return;
			this.mergeAssets(mediaAssets);
			this.missing = missing;
			this.loadedProjectId = projectId;
			if (missing.length) this.reportMissing({ projectId });
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

	/** Stored media of the loaded project that could not be read; empty when all loaded. */
	getMissingMedia(): MediaLoadFailure[] {
		return this.missing;
	}

	/** Reads the missing media again; returns the ones still missing. */
	async retryMissingMedia({ projectId }: { projectId: string }): Promise<MediaLoadFailure[]> {
		if (this.loadedProjectId !== projectId || this.missing.length === 0) return this.missing;
		const generation = this.loadGeneration;
		const results = await Promise.all(this.missing.map(async (failure) => {
			try {
				const asset = await storageService.loadMediaAsset({ projectId, id: failure.id });
				return asset ? { asset } : { failure: { ...failure, error: "not in storage" } };
			} catch (error) {
				return { failure: { ...failure, error: error instanceof Error ? error.message : String(error) } };
			}
		}));
		if (generation !== this.loadGeneration) return this.missing;
		this.mergeAssets(results.flatMap((r) => ("asset" in r && r.asset ? [r.asset] : [])));
		this.missing = results.flatMap((r) => ("failure" in r && r.failure ? [r.failure] : []));
		toast.dismiss(`missing-media-${projectId}`);
		if (this.missing.length) this.reportMissing({ projectId });
		this.notify();
		return this.missing;
	}

	private reportMissing({ projectId }: { projectId: string }): void {
		const count = this.missing.length;
		toast.error(`${count} media ${count === 1 ? "file" : "files"} could not be loaded`, {
			id: `missing-media-${projectId}`,
			description: this.missing.slice(0, 3).map((m) => m.name).join(", ") + (count > 3 ? ", …" : ""),
			duration: Number.POSITIVE_INFINITY,
			action: { label: "Retry", onClick: () => void this.retryMissingMedia({ projectId }) },
		});
	}

	/** Adds assets in front of the current ones; an id already present is replaced, not duplicated. */
	private mergeAssets(assets: MediaAsset[]): void {
		if (assets.length === 0) return;
		const incoming = new Set(assets.map((asset) => asset.id));
		this.assets = [...assets, ...this.assets.filter((asset) => !incoming.has(asset.id))];
	}

	/**
	 * Saves an import to storage without publishing it: it is not in `assets`, so no human edit,
	 * other draft, or history entry can use it until publishStagedMediaAssets. `onId` gets the id
	 * before anything is written, so the caller can always clean up. When saving fails, the partial
	 * file and metadata are removed; if that cleanup fails too, the asset stays staged for
	 * discardStagedMediaAssets to retry, and the error says so.
	 */
	async stageMediaAsset({ projectId, asset, onId }: { projectId: string; asset: Omit<MediaAsset, "id">; onId?: (id: string) => void }): Promise<MediaAsset> {
		const staged: MediaAsset = { ...asset, id: generateUUID() };
		this.staged.set(staged.id, { projectId, asset: staged });
		onId?.(staged.id);
		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: staged });
			return staged;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				await storageService.deleteMediaAsset({ projectId, id: staged.id });
				this.staged.delete(staged.id);
			} catch (cleanup) {
				throw new Error(`${message} (partial file not removed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)})`);
			}
			throw error;
		}
	}

	/** Publishes staged imports (the draft that imported them committed). */
	publishStagedMediaAssets({ ids }: { ids: string[] }): void {
		const assets = ids.flatMap((id) => {
			const entry = this.staged.get(id);
			this.staged.delete(id);
			return entry ? [entry.asset] : [];
		});
		if (assets.length === 0) return;
		const incoming = new Set(assets.map((asset) => asset.id));
		this.assets = [...this.assets.filter((asset) => !incoming.has(asset.id)), ...assets];
		this.notify();
	}

	/**
	 * Takes just-published imports back to staged, for a commit that threw in the same task as
	 * publishStagedMediaAssets (so nothing can have used them yet).
	 */
	unpublishMediaAssets({ projectId, ids }: { projectId: string; ids: string[] }): void {
		const back = new Set(ids);
		if (back.size === 0) return;
		for (const asset of this.assets) if (back.has(asset.id)) this.staged.set(asset.id, { projectId, asset });
		this.assets = this.assets.filter((asset) => !back.has(asset.id));
		this.notify();
	}

	/**
	 * Deletes staged (never published) imports from storage. Published or unknown ids are never
	 * deleted here: they are reported as failed and left alone.
	 */
	async discardStagedMediaAssets({ ids }: { ids: string[] }): Promise<DiscardResult> {
		const result: DiscardResult = { removed: [], failed: [] };
		await Promise.all([...new Set(ids)].map(async (id) => {
			const entry = this.staged.get(id);
			if (!entry) {
				if (this.assets.some((asset) => asset.id === id)) result.failed.push({ id, error: "published; kept" });
				else result.removed.push(id); // already cleaned up when its save failed
				return;
			}
			try {
				await storageService.deleteMediaAsset({ projectId: entry.projectId, id });
				this.staged.delete(id);
				result.removed.push(id);
			} catch (error) {
				result.failed.push({ id, error: error instanceof Error ? error.message : String(error) });
			}
		}));
		return result;
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
		this.missing = [];
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
