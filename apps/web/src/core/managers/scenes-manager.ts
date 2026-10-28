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
	isCompoundElement,
	syncCompoundDurations,
} from "@/timeline/compound";
import {
	type CompoundCrumb,
	getCompoundParentSceneId,
	getCompoundPath,
	getNestedTimeAtParentTime,
} from "@/timeline/compound-navigation";

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
	/** Compound scene id -> scene it was last entered from (breadcrumb and Esc go back there). */
	private compoundParents = new Map<string, string>();

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

		this.enterScene(targetScene);
		this.notify();
	}

	/**
	 * Opens a compound clip of the open scene (timeline double-click). The playhead lands on the
	 * same frame inside when it was over the clip; otherwise the nested scene's own last playhead.
	 */
	async enterCompound({
		trackId,
		elementId,
	}: {
		trackId: string;
		elementId: string;
	}): Promise<void> {
		const host = this.getActiveScene();
		const element = [...host.tracks.overlay, host.tracks.main, ...host.tracks.audio]
			.find((track) => track.id === trackId)
			?.elements.find((candidate) => candidate.id === elementId);
		if (!element || !isCompoundElement(element)) {
			throw new Error("Compound clip not found");
		}
		const nestedTime = getNestedTimeAtParentTime({
			element,
			parentTime: this.editor.playback.getCurrentTime(),
		});
		this.compoundParents.set(element.sceneId, host.id);
		await this.switchToScene({ sceneId: element.sceneId });
		if (nestedTime !== null) {
			this.editor.playback.seek({ time: nestedTime });
		}
	}

	/** Goes back to the scene the open compound was entered from. False when not inside one. */
	exitCompound(): boolean {
		const active = this.active;
		if (!active) return false;
		const parentId = getCompoundParentSceneId({
			scenes: this.list,
			sceneId: active.id,
			hint: this.compoundParents.get(active.id),
		});
		if (!parentId) return false;
		void this.switchToScene({ sceneId: parentId });
		return true;
	}

	/** Breadcrumb of the open scene: root user scene first, open scene last. */
	getCompoundPath(): CompoundCrumb[] {
		if (!this.active) return [];
		return getCompoundPath({
			scenes: this.list,
			sceneId: this.active.id,
			parentHints: this.compoundParents,
		});
	}

	/**
	 * The one way the open scene changes, for explicit switches and scene-list changes alike
	 * (e.g. deleting the open scene or undoing that). It remembers the outgoing playhead, pauses
	 * playback (switching is an edit-side jump, so playback stops cleanly at the restored
	 * playhead), clears the selection, publishes the destination together with its own restored
	 * playhead, and records it as the project's current scene. Callers notify afterwards, so
	 * duration reconciliation only sees the destination's playhead against its own duration.
	 */
	private enterScene(target: TScene | null): void {
		const previous = this.active;
		if (!target || previous?.id === target.id) {
			this.active = target;
			return;
		}

		const { playback, selection, project } = this.editor;
		if (previous) {
			this.playheads.set(previous.id, playback.getCurrentTime());
		}
		if (playback.getIsPlaying()) {
			playback.pause();
		}
		this.active = target;
		selection.clearSelection();
		playback.seek({ time: this.playheads.get(target.id) ?? ZERO_MEDIA_TIME });

		const activeProject = project.getActiveOrNull();
		if (activeProject) {
			project.setActiveProject({
				project: {
					...activeProject,
					currentSceneId: target.id,
					metadata: { ...activeProject.metadata, updatedAt: new Date() },
				},
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
		// If the open scene is gone, the main scene opens instead.
		const nextActive =
			(nextActiveSceneId ? scenes.find((scene) => scene.id === nextActiveSceneId) : undefined) ??
			(this.active ? getMainScene({ scenes }) : null);
		this.enterScene(nextActive);
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
