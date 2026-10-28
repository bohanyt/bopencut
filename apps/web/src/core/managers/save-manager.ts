import type { EditorCore } from "@/core";

type SaveManagerOptions = {
	debounceMs?: number;
};

export class SaveManager {
	private debounceMs: number;
	private isPaused = false;
	private isSaving = false;
	private hasPendingSave = false;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private unsubscribeHandlers: Array<() => void> = [];
	private savePromise: Promise<void> | null = null;
	/** When the project was last written to storage successfully (this session). */
	private lastSavedAt: Date | null = null;
	/** Message of the last failed save, cleared by the next successful one. */
	private lastError: string | null = null;
	private listeners = new Set<() => void>();

	constructor({
		editor,
		debounceMs = 800,
	}: {
		editor: EditorCore;
	} & SaveManagerOptions) {
		this.editor = editor;
		this.debounceMs = debounceMs;
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

	getIsDirty(): boolean {
		return this.hasPendingSave || this.isSaving;
	}

	getLastSavedAt(): Date | null {
		return this.lastSavedAt;
	}

	getLastError(): string | null {
		return this.lastError;
	}

	/** Notified when a save starts or ends and when changes become pending. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Saves pending changes now and resolves once nothing is pending or being saved: true when
	 * everything is on disk, false when a save failed or `timeoutMs` passed (e.g. the project is
	 * still loading and cannot be saved yet).
	 */
	async settle({ timeoutMs = 15000 }: { timeoutMs?: number } = {}): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.getIsDirty()) {
			if (Date.now() > deadline) return false;
			if (this.savePromise) await this.savePromise;
			else {
				this.clearTimer();
				await this.saveNow();
				if (this.lastError) return false;
				// Nothing could be saved yet (project loading or migrating): try again shortly.
				if (this.hasPendingSave && !this.isSaving) await new Promise((resolve) => setTimeout(resolve, 50));
			}
		}
		return this.lastError === null;
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	private queueSave(): void {
		if (this.isSaving) return;
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
		}
		this.saveTimer = setTimeout(() => {
			void this.saveNow();
		}, this.debounceMs);
	}

	private async saveNow(): Promise<void> {
		if (this.isSaving) return;
		if (!this.hasPendingSave) return;

		const activeProject = this.editor.project.getActive();
		if (!activeProject) return;
		if (this.editor.project.getIsLoading()) return;
		if (this.editor.project.getMigrationState().isMigrating) return;

		this.isSaving = true;
		this.hasPendingSave = false;
		this.clearTimer();

		const run = (async () => {
			try {
				const saved = await this.editor.project.saveCurrentProject();
				if (saved) {
					this.lastSavedAt = new Date();
					this.lastError = null;
				} else {
					// Not on disk: stays pending so readiness reports it; the next change retries.
					this.lastError = "Failed to save project";
					this.hasPendingSave = true;
				}
			} finally {
				this.isSaving = false;
				this.savePromise = null;
				if (this.hasPendingSave && !this.lastError) {
					this.queueSave();
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
