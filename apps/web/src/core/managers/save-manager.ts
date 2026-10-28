import type { EditorCore } from "@/core";
import { toast } from "sonner";

type SaveManagerOptions = {
	debounceMs?: number;
	/** Waits before automatic retries of a failed save; after the last one a manual retry is offered. */
	retryDelaysMs?: number[];
};

/** Save state of one project: last successful write to storage and the error of the last failed save. */
type ProjectSaveState = { savedAt: Date | null; error: string | null };

const SAVE_ERROR_TOAST = "project-save-error";

export class SaveManager {
	private debounceMs: number;
	private retryDelaysMs: number[];
	private isPaused = false;
	private isSaving = false;
	private hasPendingSave = false;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private unsubscribeHandlers: Array<() => void> = [];
	private savePromise: Promise<void> | null = null;
	/** Failed saves in a row (drives the retry backoff). */
	private failures = 0;
	private projects = new Map<string, ProjectSaveState>();
	private listeners = new Set<() => void>();

	constructor({
		editor,
		debounceMs = 800,
		retryDelaysMs = [1000, 2000, 4000, 8000, 16000],
	}: {
		editor: EditorCore;
	} & SaveManagerOptions) {
		this.editor = editor;
		this.debounceMs = debounceMs;
		this.retryDelaysMs = retryDelaysMs;
	}

	private editor: EditorCore;

	start(): void {
		if (this.unsubscribeHandlers.length > 0) return;

		this.unsubscribeHandlers = [
			this.editor.scenes.subscribe(() => {
				this.markDirty();
			}),
			this.editor.timeline.subscribe(() => {
				this.markDirty();
			}),
		];
	}

	stop(): void {
		for (const unsubscribe of this.unsubscribeHandlers) {
			unsubscribe();
		}
		this.unsubscribeHandlers = [];
		this.clearTimer();
	}

	pause(): void {
		this.isPaused = true;
	}

	resume(): void {
		this.isPaused = false;
		if (this.hasPendingSave) {
			this.queueSave();
		}
	}

	markDirty({ force = false }: { force?: boolean } = {}): void {
		if (this.isPaused && !force) return;
		const wasDirty = this.getIsDirty();
		this.hasPendingSave = true;
		this.queueSave();
		if (!wasDirty) this.notify();
	}

	async flush(): Promise<void> {
		this.hasPendingSave = true;
		await this.saveNow();
	}

	/** Saves again now after a failure (the error toast's Retry button). */
	async retry(): Promise<void> {
		this.failures = 0;
		this.hasPendingSave = true;
		this.clearTimer();
		await this.saveNow();
	}

	getIsDirty(): boolean {
		return this.hasPendingSave || this.isSaving;
	}

	/**
	 * Records what storage holds for a project that was just loaded or created: `savedAt` is the
	 * time of its last write (from the stored project), and no save error.
	 */
	initProject({ projectId, savedAt }: { projectId: string; savedAt: Date | null }): void {
		this.projects.set(projectId, { savedAt, error: null });
		this.failures = 0;
		this.notify();
	}

	/** Outcome of a write to storage (any caller): success sets savedAt and clears the error. */
	recordPersisted({ projectId, error }: { projectId: string; error: string | null }): void {
		const state = this.projects.get(projectId) ?? { savedAt: null, error: null };
		if (error === null) {
			if (state.error) toast.dismiss(SAVE_ERROR_TOAST);
			this.projects.set(projectId, { savedAt: new Date(), error: null });
		} else {
			this.projects.set(projectId, { ...state, error });
		}
	}

	/** Last successful write of the project (the active one by default) to storage. */
	getLastSavedAt(projectId = this.activeProjectId()): Date | null {
		return (projectId && this.projects.get(projectId)?.savedAt) || null;
	}

	/** Error of the project's last failed save, cleared by the next successful one. */
	getLastError(projectId = this.activeProjectId()): string | null {
		return (projectId && this.projects.get(projectId)?.error) || null;
	}

	/** Notified when a save starts or ends and when changes become pending. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Saves pending changes now and resolves once nothing is pending or being saved: true when
	 * everything is on disk, false when a save failed or `timeoutMs` passed (e.g. the project is
	 * still loading and cannot be saved yet, or a save hangs).
	 */
	async settle({ timeoutMs = 15000 }: { timeoutMs?: number } = {}): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		const untilDeadline = () => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())));
		while (this.getIsDirty()) {
			if (Date.now() >= deadline) return false;
			if (this.savePromise) await Promise.race([this.savePromise, untilDeadline()]);
			else {
				this.clearTimer();
				await Promise.race([this.saveNow(), untilDeadline()]);
				if (this.getLastError() && !this.isSaving) return false;
				// Nothing could be saved yet (project loading or migrating): try again shortly.
				if (this.hasPendingSave && !this.isSaving) await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		return this.getLastError() === null;
	}

	private activeProjectId(): string | null {
		return this.editor.project.getActiveOrNull()?.metadata.id ?? null;
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private queueSave(delayMs = this.debounceMs): void {
		if (this.isSaving) return;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.saveNow();
		}, delayMs);
	}

	private async saveNow(): Promise<void> {
		if (this.isSaving) return;
		if (!this.hasPendingSave) return;

		const activeProject = this.editor.project.getActiveOrNull();
		if (!activeProject) return;
		if (this.editor.project.getIsLoading()) return;
		if (this.editor.project.getMigrationState().isMigrating) return;
		const projectId = activeProject.metadata.id;

		this.isSaving = true;
		this.hasPendingSave = false;
		this.clearTimer();

		const run = (async () => {
			let retryIn: number | null = null;
			try {
				// The project manager records the outcome (recordPersisted).
				const error = await this.editor.project.persistCurrentProject();
				if (error === null) {
					this.failures = 0;
				} else {
					// Not on disk: stays pending (readiness reports it) and is retried with backoff,
					// whether or not anything else changes.
					this.hasPendingSave = true;
					retryIn = this.retryDelaysMs[this.failures] ?? null;
					this.failures++;
					toast.error("Failed to save project", {
						id: SAVE_ERROR_TOAST,
						description: retryIn === null ? `${error} · changes are not on disk` : `${error} · retrying in ${Math.round(retryIn / 1000)} s`,
						duration: retryIn === null ? Number.POSITIVE_INFINITY : retryIn + 1000,
						...(retryIn === null ? { action: { label: "Retry", onClick: () => void this.retry() } } : {}),
					});
				}
			} finally {
				this.isSaving = false;
				this.savePromise = null;
				if (this.hasPendingSave) {
					if (!this.getLastError(projectId)) this.queueSave();
					else if (retryIn !== null) this.queueSave(retryIn);
				}
				this.notify();
			}
		})();
		this.savePromise = run;
		this.notify();
		await run;
	}

	private clearTimer(): void {
		if (!this.saveTimer) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = null;
	}
}
