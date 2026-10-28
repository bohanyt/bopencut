import type { EditorSelectionPatch } from "@/selection/editor-selection";
import type { ElementRef } from "@/timeline/types";

export interface CommandResult {
	selection?: EditorSelectionPatch;
}

export function createElementSelectionResult(
	selectedElements: ElementRef[],
): CommandResult {
	return {
		selection: {
			selectedElements,
			selectedKeyframes: [],
			keyframeSelectionAnchor: null,
			selectedMaskPoints: null,
		},
	};
}

export abstract class Command {
	/** False for commands that move elements between scenes; ripple would read that as a delete. */
	readonly ripples: boolean = true;

	abstract execute(): CommandResult | undefined;

	/**
	 * True if undoing/redoing this command brings back `sceneId` itself (e.g. undoing the
	 * deletion of that scene). History only runs a command whose scene is missing in that case.
	 */
	restoresScene(_: { sceneId: string; direction: "undo" | "redo" }): boolean {
		return false;
	}

	/**
	 * Why this command cannot be undone/redone right now (e.g. a scene it changed is gone), or
	 * null. History refuses the step with this message and keeps itself as it is.
	 */
	getBlockedReason(_: { direction: "undo" | "redo" }): string | null {
		return null;
	}

	undo(): void {
		throw new Error("Undo not implemented for this command");
	}

	redo(): CommandResult | undefined {
		return this.execute();
	}
}
