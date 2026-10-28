import type { EditorCore } from "@/core";
import type { Command, CommandResult } from "@/commands";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import type { SceneTracks } from "@/timeline/types";
import type { DerivedSceneChange } from "./scenes-manager";

interface CommandHistoryEntry {
	command: Command;
	/** Scene the command ran in; undo and redo run there, whatever scene is open then. */
	sceneId: string | null;
	/** Other scenes the scenes manager changed as a side effect (compound relocation). */
	derived: DerivedSceneChange[];
	previousSelection: EditorSelectionSnapshot;
	selectionOverride?: EditorSelectionSnapshot;
}

export class CommandManager {
	public isRippleEnabled = false;
	private history: CommandHistoryEntry[] = [];
	private redoStack: CommandHistoryEntry[] = [];
	private reactors: Array<() => void> = [];

	constructor(private editor: EditorCore) {}

	execute({ command }: { command: Command }): Command {
		const sceneId = this.getActiveSceneId();
		const beforeTracks =
			this.isRippleEnabled && command.ripples
				? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
				: null;
		const previousSelection = this.getSelectionSnapshot();
		this.editor.scenes.beginDerivedLog();
		let result: CommandResult | undefined;
		try {
			result = command.execute();
			this.applyRippleIfEnabled({ beforeTracks });
		} catch (error) {
			// The command left its own scene untouched; put side effects elsewhere back too.
			this.editor.scenes.applyDerivedChanges({
				changes: this.editor.scenes.endDerivedLog(),
				side: "before",
			});
			throw error;
		}
		const derived = this.editor.scenes.endDerivedLog();
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();
		this.history.push({
			command,
			sceneId,
			derived,
			previousSelection,
			selectionOverride,
		});
		this.redoStack = [];
		return command;
	}

	push({ command }: { command: Command }): void {
		this.history.push({
			command,
			sceneId: this.getActiveSceneId(),
			derived: [],
			previousSelection: this.getSelectionSnapshot(),
		});
		this.redoStack = [];
	}

	registerReactor(reactor: () => void): void {
		this.reactors.push(reactor);
	}

	undo(): void {
		if (this.history.length === 0) return;
		const entry = this.history.pop();
		if (entry) {
			this.editor.scenes.runInScene({
				sceneId: entry.sceneId,
				fn: () => entry.command.undo(),
			});
			this.editor.scenes.applyDerivedChanges({ changes: entry.derived, side: "before" });
			// Only restore selection for commands that explicitly changed it.
			// Commands without selection intent leave selection untouched,
			// preserving any UI-driven selection changes (clicks, box select)
			// that happened between commands. Commands that remove editor-owned
			// selection targets must declare a selection override to clear stale refs.
			if (entry.selectionOverride !== undefined && this.isActiveScene(entry.sceneId)) {
				this.editor.selection.restoreSnapshot({
					snapshot: entry.previousSelection,
				});
			}
			this.redoStack.push(entry);
		}
	}

	redo(): void {
		if (this.redoStack.length === 0) return;
		const entry = this.redoStack.pop();
		if (!entry) {
			return;
		}

		const previousSelection = this.getSelectionSnapshot();
		const result = this.editor.scenes.runInScene({
			sceneId: entry.sceneId,
			fn: () => {
				const beforeTracks =
					this.isRippleEnabled && entry.command.ripples
						? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
						: null;
				const redoResult = entry.command.redo();
				this.applyRippleIfEnabled({ beforeTracks });
				this.runReactors();
				return redoResult;
			},
		});
		this.editor.scenes.applyDerivedChanges({ changes: entry.derived, side: "after" });
		const selectionOverride = this.isActiveScene(entry.sceneId)
			? this.applySelectionOverride(result)
			: undefined;

		this.history.push({
			...entry,
			previousSelection,
			selectionOverride,
		});
	}

	canUndo(): boolean {
		return this.history.length > 0;
	}

	canRedo(): boolean {
		return this.redoStack.length > 0;
	}

	clear(): void {
		this.history = [];
		this.redoStack = [];
	}

	private getActiveSceneId(): string | null {
		return this.editor.scenes.getActiveSceneOrNull()?.id ?? null;
	}

	/** Selection refs belong to one scene; only restore them while that scene is open. */
	private isActiveScene(sceneId: string | null): boolean {
		return sceneId === null || sceneId === this.getActiveSceneId();
	}

	private getSelectionSnapshot(): EditorSelectionSnapshot {
		return this.editor.selection.getSnapshot();
	}

	private applySelectionOverride(
		result: CommandResult | undefined,
	): EditorSelectionSnapshot | undefined {
		if (!result?.selection) {
			return undefined;
		}
		return this.editor.selection.applySelectionPatch({
			patch: result.selection,
		});
	}

	private runReactors(): void {
		for (const reactor of this.reactors) {
			reactor();
		}
	}

	private applyRippleIfEnabled({
		beforeTracks,
	}: {
		beforeTracks: SceneTracks | null;
	}): void {
		if (!this.isRippleEnabled || !beforeTracks) {
			return;
		}

		const afterTracks = this.editor.scenes.getActiveSceneOrNull()?.tracks;
		if (!afterTracks) {
			return;
		}
		const adjustments = computeRippleAdjustments({
			beforeTracks,
			afterTracks,
		});
		if (adjustments.length === 0) {
			return;
		}

		const tracksWithRipple = applyRippleAdjustments({
			tracks: afterTracks,
			adjustments,
		});
		this.editor.timeline.updateTracks(tracksWithRipple);
	}
}
