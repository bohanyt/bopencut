import type { EditorCore } from "@/core";
import type { Command, CommandResult } from "@/commands";
import type { EditorSelectionSnapshot } from "@/selection/editor-selection";
import { applyRippleAdjustments, computeRippleAdjustments } from "@/ripple";
import type { SceneTracks } from "@/timeline/types";
import type { DerivedSceneChange } from "./scenes-manager";
import { toast } from "sonner";

interface CommandHistoryEntry {
	command: Command;
	projectSession: number;
	rippleEnabled: boolean;
	/** Scene the command ran in; undo and redo switch the editor to it first. */
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
		const projectSession = this.editor.project.getSession();
		const sceneId = this.getActiveSceneId();
		const rippleEnabled = this.isRippleEnabled;
		const beforeTracks =
			rippleEnabled && command.ripples
				? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
				: null;
		const previousSelection = this.getSelectionSnapshot();
		this.editor.scenes.beginDerivedLog();
		let result: CommandResult | undefined;
		try {
			result = command.execute({ rippleEnabled });
			if (result?.changed !== false) this.applyRipple({ beforeTracks });
		} catch (error) {
			// The command left its own scene untouched; put side effects elsewhere back too.
			this.editor.scenes.applyDerivedChanges({
				changes: this.editor.scenes.endDerivedLog(),
				side: "before",
			});
			throw error;
		}
		const derived = this.editor.scenes.endDerivedLog();
		if (result?.changed === false) return command;
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();
		if (projectSession !== this.editor.project.getSession()) return command;
		this.history.push({
			command,
			projectSession,
			rippleEnabled,
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
			projectSession: this.editor.project.getSession(),
			// The edit has already been applied without command-manager ripple.
			rippleEnabled: false,
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
		const entry = this.history.at(-1);
		if (!entry || !this.showSceneOf({ entry, direction: "undo" })) return;
		this.history.pop();
		entry.command.undo();
		this.editor.scenes.applyDerivedChanges({ changes: entry.derived, side: "before" });
		// Only restore selection for commands that explicitly changed it.
		// Commands without selection intent leave selection untouched,
		// preserving any UI-driven selection changes (clicks, box select)
		// that happened between commands. Commands that remove editor-owned
		// selection targets must declare a selection override to clear stale refs.
		if (entry.selectionOverride !== undefined) {
			this.editor.selection.restoreSnapshot({
				snapshot: entry.previousSelection,
			});
		}
		if (entry.projectSession === this.editor.project.getSession()) {
			this.redoStack.push(entry);
		}
	}

	redo(): void {
		const entry = this.redoStack.at(-1);
		if (!entry || !this.showSceneOf({ entry, direction: "redo" })) return;
		this.redoStack.pop();

		const beforeTracks =
			entry.rippleEnabled && entry.command.ripples
				? (this.editor.scenes.getActiveSceneOrNull()?.tracks ?? null)
				: null;
		const previousSelection = this.getSelectionSnapshot();
		const result = entry.command.redo({ rippleEnabled: entry.rippleEnabled });
		if (result?.changed === false) return;
		this.applyRipple({ beforeTracks });
		this.editor.scenes.applyDerivedChanges({ changes: entry.derived, side: "after" });
		const selectionOverride = this.applySelectionOverride(result);
		this.runReactors();
		if (entry.projectSession !== this.editor.project.getSession()) return;

		this.history.push({
			...entry,
			previousSelection,
			selectionOverride,
		});
	}

	/**
	 * Undo/redo only replay commands from the current project session. The editor switches to
	 * the scene the command ran in first. If that scene is gone and the command cannot restore
	 * it, the step is refused and history stays as it was.
	 */
	private showSceneOf({
		entry,
		direction,
	}: {
		entry: CommandHistoryEntry;
		direction: "undo" | "redo";
	}): boolean {
		if (entry.projectSession !== this.editor.project.getSession()) return false;

		const blocked = entry.command.getBlockedReason({ direction });
		if (blocked) {
			toast.error(blocked);
			return false;
		}
		const { sceneId } = entry;
		if (sceneId === null || sceneId === this.getActiveSceneId()) return true;
		if (this.editor.scenes.getScenes().some((scene) => scene.id === sceneId)) {
			void this.editor.scenes.switchToScene({ sceneId });
			return entry.projectSession === this.editor.project.getSession();
		}
		if (entry.command.restoresScene({ sceneId, direction })) return true;
		toast.error(`Cannot ${direction}: the scene this change was made in no longer exists`);
		return false;
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

	/** Ripples the active scene after a change when the caller captured its pre-edit tracks. */
	applyRipple({
		beforeTracks,
	}: {
		beforeTracks: SceneTracks | null;
	}): void {
		if (!beforeTracks) {
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
