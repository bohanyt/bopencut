import type { TProject, TProjectMetadata } from "@/project/types";
import { getProjectDurationFromScenes } from "@/timeline/scenes";
import type { MediaAsset } from "@/media/types";
import { IndexedDBAdapter } from "./indexeddb-adapter";
import { OPFSAdapter } from "./opfs-adapter";
import { DiskAdapter, DiskSoundsAdapter } from "./disk-adapter";
import { toast } from "sonner";
import { getProjectId } from "./migrations/transformers/utils";
import type { ProjectRecord } from "./migrations/transformers/types";
import { type StorageCapacityCheckResult, isStorageQuotaExceededError } from "./quota";
import type {
	MediaAssetData,
	StorageConfig,
	SerializedProject,
	SerializedScene,
} from "./types";
import type { SavedSoundsData, SavedSound, SoundEffect } from "@/sounds/types";
import { migrations } from "@/services/storage/migrations";
import type { Bookmark, SceneTracks, TScene } from "@/timeline";
import { roundMediaTime } from "@/wasm";

function normalizeBookmarks({ raw }: { raw: unknown }): Bookmark[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((item): Bookmark | null => {
			if (typeof item === "number") {
				return { time: roundMediaTime({ time: item }) };
			}
			const obj = item as Record<string, unknown>;
			if (
				typeof obj !== "object" ||
				obj === null ||
				typeof obj.time !== "number"
			) {
				return null;
			}
			return {
				time: roundMediaTime({ time: obj.time }),
				...(typeof obj.id === "string" && { id: obj.id }),
				...((obj.author === "user" || obj.author === "agent") && { author: obj.author }),
				...(typeof obj.resolved === "boolean" && { resolved: obj.resolved }),
				...(typeof obj.createdAt === "string" && { createdAt: obj.createdAt }),
				...(Array.isArray(obj.replies) && { replies: obj.replies.filter((r): r is NonNullable<Bookmark["replies"]>[number] => !!r && typeof r.id === "string" && typeof r.text === "string" && (r.author === "user" || r.author === "agent") && typeof r.createdAt === "string") }),
				...(Array.isArray(obj.elementIds) && { elementIds: obj.elementIds.filter((id): id is string => typeof id === "string") }),
				...(typeof obj.note === "string" && { note: obj.note }),
				...(typeof obj.color === "string" && { color: obj.color }),
				...(typeof obj.duration === "number" && {
					duration: roundMediaTime({ time: obj.duration }),
				}),
			};
		})
		.filter((b): b is Bookmark => b !== null);
}

class StorageService {
	private projectsAdapter = new DiskAdapter();
	private savedSoundsAdapter = new DiskSoundsAdapter<SavedSoundsData>();
	private config: StorageConfig;
	private migrationsPromise: Promise<void> | null = null;

	constructor() {
		this.config = {
			projectsDb: "video-editor-projects",
			mediaDb: "video-editor-media",
			savedSoundsDb: "video-editor-saved-sounds",
			version: 1,
		};
	}

	async ensureMigrations(): Promise<void> {
		if (!this.migrationsPromise) this.migrationsPromise = (async () => {
			await this.migrateBrowserProjects();
			await this.migrateDiskProjects();
		})();
		await this.migrationsPromise;
	}

	private async migrateBrowserProjects(): Promise<void> {
		if (typeof indexedDB === "undefined") return;
		const legacy = new IndexedDBAdapter<ProjectRecord>({ dbName: this.config.projectsDb, storeName: "projects", version: 1 });
		let copied = 0, failed = 0;
		try {
			for (const source of await legacy.getAll()) {
				const id = getProjectId({ project: source });
				if (!id) { failed++; continue; }
				try {
					if (await this.projectsAdapter.migrationExists(id)) continue;
					let project = source;
					let version = typeof project.version === "number" ? project.version : (Array.isArray(project.scenes) && project.scenes.length ? 1 : 0);
					for (const migration of migrations) {
						if (migration.from !== version) continue;
						const result = await migration.run({ projectId: id, project });
						if (result.skipped) throw new Error(result.reason ?? "Version migration failed");
						project = result.project;
						version = migration.to;
					}
					const { mediaMetadataAdapter, mediaAssetsAdapter } = this.getProjectMediaAdapters({ projectId: id });
					for (const metadata of await mediaMetadataAdapter.getAll()) {
						const file = await mediaAssetsAdapter.get(metadata.id);
						if (!file) throw new Error(`Media ${metadata.id} not found`);
						await this.projectsAdapter.saveMedia(id, { ...metadata, fileName: metadata.fileName ?? file.name, fileType: metadata.fileType ?? file.type }, file);
					}
					if (await this.projectsAdapter.migrate(project as unknown as SerializedProject)) copied++;
				} catch (error) { failed++; console.error("Project migration failed:", id, error); }
			}
		} catch (error) { failed++; console.error("Browser migration failed:", error); }
		try {
			const sounds = new IndexedDBAdapter<SavedSoundsData>({ dbName: this.config.savedSoundsDb, storeName: "saved-sounds", version: 1 });
			const data = await sounds.get("user-sounds");
			if (data && !(await this.savedSoundsAdapter.get("user-sounds"))) await this.savedSoundsAdapter.migrate(data);
		} catch (error) { console.error("Sound migration failed:", error); toast.error("Failed to copy saved sounds; browser data remains."); }

		if (copied) toast.success(`${copied} browser projects copied to storage.`);
		if (failed) toast.error(`${failed} browser projects failed to copy; browser data remains. Reload to retry.`);
	}

	private async migrateDiskProjects(): Promise<void> {
		for (const entry of await this.projectsAdapter.getAll()) {
			const id = entry?.metadata?.id;
			if (!id || typeof entry.version !== "number" || entry.version >= (migrations.at(-1)?.to ?? entry.version)) continue;
			const source = await this.projectsAdapter.get(id);
			if (!source || typeof source.version !== "number") continue;
			let project = source as unknown as ProjectRecord;
			let version = source.version;
			for (const migration of migrations) {
				if (migration.from !== version) continue;
				const result = await migration.run({ projectId: id, project });
				if (result.skipped) throw new Error(`Project migration ${id}: ${result.reason ?? "failed"}`);
				project = result.project;
				version = migration.to;
			}
			if (version !== source.version) await this.projectsAdapter.set({ key: id, value: project as unknown as SerializedProject });
		}
	}

	private getProjectMediaAdapters({ projectId }: { projectId: string }) {
		const mediaMetadataAdapter = new IndexedDBAdapter<MediaAssetData>({
			dbName: `${this.config.mediaDb}-${projectId}`,
			storeName: "media-metadata",
			version: this.config.version,
		});

		const mediaAssetsAdapter = new OPFSAdapter(`media-files-${projectId}`);

		return { mediaMetadataAdapter, mediaAssetsAdapter };
	}

	async canStoreFile({
		size,
	}: {
		size: number;
	}): Promise<StorageCapacityCheckResult> {
		return { canStore: true, reason: "estimate-unavailable", availableBytes: null };
	}

	isQuotaExceededError({ error }: { error: unknown }): boolean {
		return isStorageQuotaExceededError({ error });
	}

	private stripAudioBuffers({ tracks }: { tracks: SceneTracks }): SceneTracks {
		return {
			...tracks,
			audio: tracks.audio.map((track) => ({
				...track,
				elements: track.elements.map((element) => {
					if (element.type !== "audio") return element;
					const { buffer: _buffer, ...rest } = element;
					return rest;
				}),
			})),
		};
	}

	async saveProject({ project }: { project: TProject }): Promise<void> {
		const duration =
			project.metadata.duration ??
			getProjectDurationFromScenes({ scenes: project.scenes });
		const serializedScenes: SerializedScene[] = project.scenes.map((scene) => ({
			id: scene.id,
			name: scene.name,
			isMain: scene.isMain,
			...(scene.kind && { kind: scene.kind }),
			...(scene.compoundOrigin && { compoundOrigin: scene.compoundOrigin }),
			tracks: this.stripAudioBuffers({ tracks: scene.tracks }),
			bookmarks: scene.bookmarks,
			createdAt: scene.createdAt.toISOString(),
			updatedAt: scene.updatedAt.toISOString(),
		}));

		const serializedProject: SerializedProject = {
			metadata: {
				id: project.metadata.id,
				name: project.metadata.name,
				thumbnail: project.metadata.thumbnail,
				duration,
				createdAt: project.metadata.createdAt.toISOString(),
				updatedAt: project.metadata.updatedAt.toISOString(),
			},
			scenes: serializedScenes,
			currentSceneId: project.currentSceneId,
			settings: project.settings,
			version: project.version,
			timelineViewState: project.timelineViewState,
		};

		await this.projectsAdapter.set({
			key: project.metadata.id,
			value: serializedProject,
		});
	}

	async loadProject({
		id,
	}: {
		id: string;
	}): Promise<{ project: TProject } | null> {
		await this.ensureMigrations();
		const serializedProject = await this.projectsAdapter.get(id);

		if (!serializedProject) return null;

		if (
			typeof serializedProject !== "object" ||
			serializedProject === null ||
			typeof serializedProject.metadata !== "object" ||
			serializedProject.metadata === null
		) {
			console.warn(
				"[storage] Skipping malformed project entry (missing metadata):",
				{ id, entry: serializedProject },
			);
			return null;
		}

		const scenes =
			serializedProject.scenes?.map((scene) => ({
				id: scene.id,
				name: scene.name,
				isMain: scene.isMain,
				...(scene.kind && { kind: scene.kind }),
				...(scene.compoundOrigin && { compoundOrigin: scene.compoundOrigin }),
				tracks: scene.tracks,
				bookmarks: normalizeBookmarks({ raw: scene.bookmarks }),
				createdAt: new Date(scene.createdAt),
				updatedAt: new Date(scene.updatedAt),
			})) ?? [];

		const project: TProject = {
			metadata: {
				id: serializedProject.metadata.id,
				name: serializedProject.metadata.name,
				thumbnail: serializedProject.metadata.thumbnail,
				duration: roundMediaTime({
					time:
						serializedProject.metadata.duration ??
						getProjectDurationFromScenes({ scenes }),
				}),
				createdAt: new Date(serializedProject.metadata.createdAt),
				updatedAt: new Date(serializedProject.metadata.updatedAt),
			},
			scenes,
			currentSceneId: serializedProject.currentSceneId || "",
			settings: serializedProject.settings,
			version: serializedProject.version,
			timelineViewState: serializedProject.timelineViewState,
		};

		return { project };
	}

	async loadAllProjects(): Promise<TProject[]> {
		const projectIds = await this.projectsAdapter.list();
		const projects: TProject[] = [];

		for (const id of projectIds) {
			const result = await this.loadProject({ id });
			if (result?.project) {
				projects.push(result.project);
			}
		}

		return projects.sort(
			(a, b) => b.metadata.updatedAt.getTime() - a.metadata.updatedAt.getTime(),
		);
	}

	async loadAllProjectsMetadata(): Promise<TProjectMetadata[]> {
		await this.ensureMigrations();
		const serializedProjects = await this.projectsAdapter.getAll();

		const metadata: TProjectMetadata[] = [];
		for (const serializedProject of serializedProjects) {
			if (
				typeof serializedProject !== "object" ||
				serializedProject === null ||
				typeof serializedProject.metadata !== "object" ||
				serializedProject.metadata === null
			) {
				console.warn(
					"[storage] Skipping malformed project entry (missing metadata):",
					serializedProject,
				);
				continue;
			}

			metadata.push({
				id: serializedProject.metadata.id,
				name: serializedProject.metadata.name,
				thumbnail: serializedProject.metadata.thumbnail,
				duration: roundMediaTime({
					time:
						serializedProject.metadata.duration ??
						getProjectDurationFromScenes({
							scenes: (serializedProject.scenes ?? []) as unknown as TScene[],
						}),
				}),
				createdAt: new Date(serializedProject.metadata.createdAt),
				updatedAt: new Date(serializedProject.metadata.updatedAt),
			});
		}

		return metadata.sort(
			(a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
		);
	}

	async deleteProject({ id }: { id: string }): Promise<void> {
		await this.projectsAdapter.remove(id);
	}

	async saveMediaAsset({
		projectId,
		mediaAsset,
	}: {
		projectId: string;
		mediaAsset: MediaAsset;
	}): Promise<void> {

		const metadata: MediaAssetData = {
			id: mediaAsset.id,
			name: mediaAsset.name,
			fileName: mediaAsset.file.name,
			fileType: mediaAsset.file.type,
			type: mediaAsset.type,
			size: mediaAsset.file.size,
			lastModified: mediaAsset.file.lastModified,
			width: mediaAsset.width,
			height: mediaAsset.height,
			duration: mediaAsset.duration,
			fps: mediaAsset.fps,
			hasAudio: mediaAsset.hasAudio,
			thumbnailUrl: mediaAsset.thumbnailUrl,
			ephemeral: mediaAsset.ephemeral,
		};

		await this.projectsAdapter.saveMedia(projectId, metadata, mediaAsset.file);
	}

	async loadMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<MediaAsset | null> {
		const metadata = (await this.projectsAdapter.mediaList(projectId)).find((item) => item.id === id);
		if (!metadata) return null;
		return this.readMediaAsset({ projectId, metadata });
	}

	private async readMediaAsset({
		projectId,
		metadata,
	}: {
		projectId: string;
		metadata: MediaAssetData;
	}): Promise<MediaAsset> {
		const id = metadata.id;
		const url = this.projectsAdapter.mediaUrl(projectId, id);
		const response = await fetch(url);
		if (!response.ok) throw new Error(`Media ${id} cannot be read`);
		const blob = await response.blob();
		const file = new File([blob], metadata.fileName ?? metadata.name, { type: metadata.fileType ?? blob.type, lastModified: metadata.lastModified });

		return {
			id: metadata.id,
			name: metadata.name,
			type: metadata.type,
			file,
			url,
			width: metadata.width,
			height: metadata.height,
			duration: metadata.duration,
			fps: metadata.fps,
			hasAudio: metadata.hasAudio,
			thumbnailUrl: metadata.thumbnailUrl,
			ephemeral: metadata.ephemeral,
		};
	}

	/** Loads every media asset: the metadata list is fetched once and files are read with bounded concurrency. */
	async loadAllMediaAssets({
		projectId,
		concurrency = 8,
		onProgress,
	}: {
		projectId: string;
		concurrency?: number;
		onProgress?: (progress: { loaded: number; total: number }) => void;
	}): Promise<MediaAsset[]> {
		const list = await this.projectsAdapter.mediaList(projectId);
		const items: (MediaAsset | null)[] = new Array(list.length).fill(null);
		let next = 0;
		let loaded = 0;
		const worker = async () => {
			while (next < list.length) {
				const index = next++;
				try {
					items[index] = await this.readMediaAsset({ projectId, metadata: list[index] });
				} catch (error) {
					console.error(`Failed to load media ${list[index].id}:`, error);
				}
				loaded++;
				onProgress?.({ loaded, total: list.length });
			}
		};
		await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), list.length) }, worker));
		return items.filter((item): item is MediaAsset => item !== null);
	}

	async deleteMediaAsset({
		projectId,
		id,
	}: {
		projectId: string;
		id: string;
	}): Promise<void> {
		await this.projectsAdapter.removeMedia(projectId, id);
	}

	async deleteProjectMedia({
		projectId,
	}: {
		projectId: string;
	}): Promise<void> {
		await this.projectsAdapter.removeProjectMedia(projectId);
	}

	async clearAllData(): Promise<void> {
		await this.projectsAdapter.clear();
		// project-specific media and timelines cleaned up when projects are deleted
	}

	async getStorageInfo(): Promise<{
		projects: number;
		isOPFSSupported: boolean;
		isIndexedDBSupported: boolean;
	}> {
		const projectIds = await this.projectsAdapter.list();

		return {
			projects: projectIds.length,
			isOPFSSupported: this.isOPFSSupported(),
			isIndexedDBSupported: this.isIndexedDBSupported(),
		};
	}

	async getProjectStorageInfo({ projectId }: { projectId: string }): Promise<{
		mediaItems: number;
	}> {
		const mediaIds = await this.projectsAdapter.mediaList(projectId);

		return {
			mediaItems: mediaIds.length,
		};
	}

	async loadSavedSounds(): Promise<SavedSoundsData> {
		try {
			const savedSoundsData = await this.savedSoundsAdapter.get("user-sounds");
			return (
				savedSoundsData || {
					sounds: [],
					lastModified: new Date().toISOString(),
				}
			);
		} catch (error) {
			console.error("Failed to load saved sounds:", error);
			return { sounds: [], lastModified: new Date().toISOString() };
		}
	}

	async saveSoundEffect({
		soundEffect,
	}: {
		soundEffect: SoundEffect;
	}): Promise<void> {
		try {
			const currentData = await this.loadSavedSounds();

			if (currentData.sounds.some((sound) => sound.id === soundEffect.id)) {
				return; // Already saved
			}

			const savedSound: SavedSound = {
				id: soundEffect.id,
				name: soundEffect.name,
				username: soundEffect.username,
				previewUrl: soundEffect.previewUrl,
				downloadUrl: soundEffect.downloadUrl,
				duration: soundEffect.duration,
				tags: soundEffect.tags,
				license: soundEffect.license,
				savedAt: new Date().toISOString(),
			};

			const updatedData: SavedSoundsData = {
				sounds: [...currentData.sounds, savedSound],
				lastModified: new Date().toISOString(),
			};

			await this.savedSoundsAdapter.set({
				key: "user-sounds",
				value: updatedData,
			});
		} catch (error) {
			console.error("Failed to save sound effect:", error);
			throw error;
		}
	}

	async removeSavedSound({ soundId }: { soundId: number }): Promise<void> {
		try {
			const currentData = await this.loadSavedSounds();

			const updatedData: SavedSoundsData = {
				sounds: currentData.sounds.filter((sound) => sound.id !== soundId),
				lastModified: new Date().toISOString(),
			};

			await this.savedSoundsAdapter.set({
				key: "user-sounds",
				value: updatedData,
			});
		} catch (error) {
			console.error("Failed to remove saved sound:", error);
			throw error;
		}
	}

	async isSoundSaved({ soundId }: { soundId: number }): Promise<boolean> {
		try {
			const currentData = await this.loadSavedSounds();
			return currentData.sounds.some((sound) => sound.id === soundId);
		} catch (error) {
			console.error("Failed to check if sound is saved:", error);
			return false;
		}
	}

	async clearSavedSounds(): Promise<void> {
		try {
			await this.savedSoundsAdapter.remove("user-sounds");
		} catch (error) {
			console.error("Failed to clear saved sounds:", error);
			throw error;
		}
	}

	isOPFSSupported(): boolean {
		return OPFSAdapter.isSupported();
	}

	isIndexedDBSupported(): boolean {
		return "indexedDB" in window;
	}

	isFullySupported(): boolean {
		return typeof fetch !== "undefined";
	}
}

export const storageService = new StorageService();
export { StorageService };
