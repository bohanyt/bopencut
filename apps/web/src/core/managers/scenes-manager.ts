import type { EditorCore } from "@/core";
import type { Bookmark, SceneTracks, TScene } from "@/timeline";
import { storageService } from "@/services/storage/service";
import {
	getMainScene,
	ensureMainScene,
	canDeleteScene,
	findCurrentScene,
} from "@/timeline/scenes";
import {
	getBookmarkAtTime,
	getFrameTime,
	isBookmarkAtTime,
} from "@/timeline/bookmarks/index";
import {
	CreateSceneCommand,
	DeleteSceneCommand,
	MoveBookmarkCommand,
	RemoveBookmarkCommand,
	RenameSceneCommand,
	ToggleBookmarkCommand,
	UpdateBookmarkCommand,
} from "@/commands/scene";
import { type MediaTime, ZERO_MEDIA_TIME } from "@/wasm";
import {
	assertTracksAcyclic,
	relocateVisualCompounds,
	syncCompoundDurations,
} from "@/timeline/compound";

/** Tracks of another scene that the scenes manager changed itself while a command ran. */
export interface DerivedSceneChange {
	sceneId: string;
	before: SceneTracks;
	after: SceneTracks;
}

export class ScenesManager {
	private active: TScene | null = null;
	private list: TScene[] = [];
	private listeners = new Set<() => void>();
	private derivedLog: Map<string, { before: SceneTracks; after: SceneTracks }> | null = null;
	/** Last playhead of each scene, restored when the editor switches back to it. */
	private playheads = new Map<string, MediaTime>();

	constructor(private editor: EditorCore) {}

	async createScene({
		name,
		isMain = false,
	}: {
		name: string;
		isMain: boolean;
	}): Promise<string> {
		if (!this.editor.project.getActive()) {
			throw new Error("No active project");
		}

		const command = new CreateSceneCommand({ name, isMain });
		this.editor.command.execute({ command });
		return command.getSceneId();
	}

	async deleteScene({ sceneId }: { sceneId: string }): Promise<void> {
		const sceneToDelete = this.list.find((s) => s.id === sceneId);

		if (!sceneToDelete) {
			throw new Error("Scene not found");
		}

		const { canDelete, reason } = canDeleteScene({
			scene: sceneToDelete,
			scenes: this.list,
		});
		if (!canDelete) {
			throw new Error(reason);
		}

		if (!this.editor.project.getActive()) {
			throw new Error("No active project");
		}

		const command = new DeleteSceneCommand(sceneId);
		this.editor.command.execute({ command });
	}

	async renameScene({
		sceneId,
		name,
	}: {
		sceneId: string;
		name: string;
	}): Promise<void> {
		if (!this.editor.project.getActive()) {
			throw new Error("No active project");
		}

		const command = new RenameSceneCommand({
			sceneId,
			newName: name,
		});
		this.editor.command.execute({ command });
	}

	async switchToScene({ sceneId }: { sceneId: string }): Promise<void> {
		const targetScene = this.list.find((s) => s.id === sceneId);

		if (!targetScene) {
			throw new Error("Scene not found");
		}

		const previousId = this.active?.id ?? null;
		if (previousId && previousId !== sceneId) {
			this.playheads.set(previousId, this.editor.playback.getCurrentTime());
		}

		const activeProject = this.editor.project.getActive();

		if (activeProject) {
			const updatedProject = {
				...activeProject,
				currentSceneId: sceneId,
				metadata: {
					...activeProject.metadata,
					updatedAt: new Date(),
				},
			};

			this.editor.project.setActiveProject({ project: updatedProject });
		}

		this.active = targetScene;
		this.notify();
		if (previousId !== sceneId) {
			// Selection refs belong to the scene that was open.
			this.editor.selection.clearSelection();
			this.editor.playback.seek({
				time: this.playheads.get(sceneId) ?? ZERO_MEDIA_TIME,
			});
		}
	}

	async toggleBookmark({ time }: { time: MediaTime }): Promise<void> {
		const command = new ToggleBookmarkCommand(time);
		this.editor.command.execute({ command });
	}

	isBookmarked({ time }: { time: MediaTime }): boolean {
		const activeScene = this.getActiveScene();
		const activeProject = this.editor.project.getActive();

		if (!activeScene || !this.active || !activeProject) return false;

		const frameTime = getFrameTime({
			time,
			fps: activeProject.settings.fps,
		});

		return isBookmarkAtTime({ bookmarks: activeScene.bookmarks, frameTime });
	}

	async removeBookmark({ time }: { time: MediaTime }): Promise<void> {
		const command = new RemoveBookmarkCommand(time);
		this.editor.command.execute({ command });
	}

	async updateBookmark({
		time,
		updates,
	}: {
		time: MediaTime;
		updates: Partial<Omit<Bookmark, "time">>;
	}): Promise<void> {
		const command = new UpdateBookmarkCommand({ time, updates });
		this.editor.command.execute({ command });
	}

	async moveBookmark({
		fromTime,
		toTime,
	}: {
		fromTime: MediaTime;
		toTime: MediaTime;
	}): Promise<void> {
		const command = new MoveBookmarkCommand({ fromTime, toTime });
		this.editor.command.execute({ command });
	}

	getBookmarkAtTime({ time }: { time: MediaTime }) {
		const activeScene = this.active;
		const activeProject = this.editor.project.getActive();

		if (!activeScene || !activeProject) return null;

		const frameTime = getFrameTime({
			time,
			fps: activeProject.settings.fps,
		});

		return getBookmarkAtTime({
			bookmarks: activeScene.bookmarks,
			frameTime,
		});
	}

	async loadProjectScenes({ projectId }: { projectId: string }): Promise<void> {
		try {
			const result = await storageService.loadProject({ id: projectId });
			if (result?.project.scenes) {
				const ensuredScenes = this.normalize(result.project.scenes ?? []);
				const currentScene = findCurrentScene({
					scenes: ensuredScenes,
					currentSceneId: result.project.currentSceneId,
				});

				this.list = ensuredScenes;
				this.active = currentScene;
				this.notify();
			}
		} catch (error) {
			console.error("Failed to load project scenes:", error);
			this.list = [];
			this.active = null;
			this.notify();
		}
	}

	initializeScenes({
		scenes,
		currentSceneId,
	}: {
		scenes: TScene[];
		currentSceneId?: string;
	}): void {
		const ensuredScenes = this.normalize(ensureMainScene({ scenes }));
		const currentScene = currentSceneId
			? ensuredScenes.find((s) => s.id === currentSceneId)
			: null;

		const fallbackScene = getMainScene({ scenes: ensuredScenes });

		this.list = ensuredScenes;
		this.active = currentScene || fallbackScene;
		this.notify();

		const hasAddedMainScene = ensuredScenes.length > scenes.length;
		if (hasAddedMainScene) {
			const activeProject = this.editor.project.getActive();

			if (activeProject) {
				const updatedProject = {
					...activeProject,
					scenes: ensuredScenes,
					metadata: {
						...activeProject.metadata,
						updatedAt: new Date(),
					},
				};

				this.editor.project.setActiveProject({ project: updatedProject });
				this.editor.save.markDirty({ force: true });
			}
		}
	}

	clearScenes(): void {
		this.list = [];
		this.active = null;
		this.notify();
	}

	getActiveScene(): TScene {
		if (!this.active) {
			throw new Error("No active scene.");
		}
		return this.active;
	}

	getActiveSceneOrNull(): TScene | null {
		return this.active;
	}

	getScenes(): TScene[] {
		return this.list;
	}

	setScenes({
		scenes,
		activeSceneId,
	}: {
		scenes: TScene[];
		activeSceneId?: string;
	}): void {
		// Reject a cycle before anything changes; then keep compound durations in step.
		for (const scene of scenes) {
			if (this.list.includes(scene)) continue;
			assertTracksAcyclic({ scenes, sceneId: scene.id, tracks: scene.tracks });
		}
		scenes = this.normalize(scenes);
		this.list = scenes;
		const nextActiveSceneId = activeSceneId ?? this.active?.id ?? null;
		this.active = nextActiveSceneId
			? (scenes.find((scene) => scene.id === nextActiveSceneId) ?? null)
			: null;
		this.notify();

		const activeProject = this.editor.project.getActive();
		if (activeProject) {
			const updatedProject = {
				...activeProject,
				scenes,
				metadata: {
					...activeProject.metadata,
					updatedAt: new Date(),
				},
			};
			this.editor.project.setActiveProject({ project: updatedProject });
		}
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Starts recording tracks of other scenes that change as a side effect (compound relocation). */
	beginDerivedLog(): void {
		this.derivedLog = new Map();
	}

	endDerivedLog(): DerivedSceneChange[] {
		const changes = [...(this.derivedLog ?? new Map()).entries()].map(
			([sceneId, change]) => ({ sceneId, ...change }),
		);
		this.derivedLog = null;
		return changes;
	}

	/** Puts derived changes back (undo, failed command) or re-applies them (redo). */
	applyDerivedChanges({
		changes,
		side,
	}: {
		changes: DerivedSceneChange[];
		side: "before" | "after";
	}): void {
		if (changes.length === 0) return;
		const tracksById = new Map(changes.map((change) => [change.sceneId, change[side]]));
		this.setScenes({
			scenes: this.list.map((scene) => {
				const tracks = tracksById.get(scene.id);
				return tracks ? { ...scene, tracks } : scene;
			}),
		});
	}

	/**
	 * Derived compound state: clips that gained visuals leave audio tracks, then every
	 * sourceDuration follows its nested scene. Relocations of scenes other than the active one
	 * are logged so the running command can undo and redo them.
	 */
	private normalize(scenes: TScene[]): TScene[] {
		const relocated = relocateVisualCompounds(scenes);
		const synced = syncCompoundDurations(relocated);
		if (this.derivedLog && relocated !== scenes) {
			for (const [index, scene] of scenes.entries()) {
				if (relocated[index] === scene || scene.id === this.active?.id) continue;
				const logged = this.derivedLog.get(scene.id);
				this.derivedLog.set(scene.id, {
					before: logged?.before ?? scene.tracks,
					after: synced[index].tracks,
				});
			}
		}
		return synced;
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}

	updateSceneTracks({ tracks }: { tracks: SceneTracks }): void {
		if (!this.active) return;
		const activeId = this.active.id;
		// Every timeline edit lands here, so this is the boundary that keeps compound cycles out.
		assertTracksAcyclic({ scenes: this.list, sceneId: activeId, tracks });

		const updatedScene: TScene = {
			...this.active,
			tracks,
			updatedAt: new Date(),
		};

		this.list = this.normalize(
			this.list.map((s) => (s.id === activeId ? updatedScene : s)),
		);
		this.active = this.list.find((s) => s.id === activeId) ?? updatedScene;
		this.notify();

		const activeProject = this.editor.project.getActive();
		if (activeProject) {
			const updatedProject = {
				...activeProject,
				scenes: this.list,
				metadata: {
					...activeProject.metadata,
					updatedAt: new Date(),
				},
			};
			this.editor.project.setActiveProject({ project: updatedProject });
		}
	}
}
