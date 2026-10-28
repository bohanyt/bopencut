import { Command, createElementSelectionResult, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { ElementRef, TScene } from "@/timeline";

type SceneChange = { sceneId: string; before: TScene | null; after: TScene | null };

/**
 * One undo step for a whole agent draft: every scene it changed, created, or removed (root
 * timeline, compound clip contents) is restored together. The selection of changed items is
 * part of the result, so redo selects them again. Each direction opens its own scene through the
 * scenes manager's transition (playhead, selection): undo the scene that was open when the draft
 * ran, redo the scene that was open after it (the root when the draft removed the open scene,
 * e.g. by ungrouping the compound being edited).
 */
export class AgentDraftCommand extends Command {
	// Ripple was already applied per op while the draft was computed.
	override readonly ripples = false;
	private readonly changes: SceneChange[];
	private readonly selection: ElementRef[];
	private readonly wrap: (action: () => void) => void;
	private readonly open: { before: string | null; after: string | null };

	constructor({ before, after, selection, openBefore = null, openAfter = openBefore, wrap = (action) => action() }: {
		before: TScene[]; after: TScene[];
		/** Refs in `openAfter`, the scene open once the draft is applied. */
		selection: ElementRef[];
		openBefore?: string | null; openAfter?: string | null;
		wrap?: (action: () => void) => void;
	}) {
		super();
		const old = new Map(before.map((scene) => [scene.id, scene]));
		const next = new Set(after.map((scene) => scene.id));
		this.changes = [
			...after.filter((scene) => old.get(scene.id) !== scene).map((scene) => ({ sceneId: scene.id, before: old.get(scene.id) ?? null, after: scene })),
			...before.filter((scene) => !next.has(scene.id)).map((scene) => ({ sceneId: scene.id, before: scene, after: null })),
		];
		this.selection = selection;
		this.open = { before: openBefore, after: openAfter };
		this.wrap = wrap;
	}

	/** Undo brings back the scenes the draft removed, redo the ones it created. */
	override restoresScene({ sceneId, direction }: { sceneId: string; direction: "undo" | "redo" }): boolean {
		const side = direction === "undo" ? "before" : "after";
		return this.changes.some((change) => change.sceneId === sceneId && change[side] !== null);
	}

	getChangedSceneIds(): string[] {
		return this.changes.map((change) => change.sceneId);
	}

	override getBlockedReason({ direction }: { direction: "undo" | "redo" }): string | null {
		// Undo needs every scene the draft left in place; redo every scene it started from.
		const side = direction === "undo" ? "after" : "before";
		const present = new Set(EditorCore.getInstance().scenes.getScenes().map((scene) => scene.id));
		const missing = this.changes.filter((change) => change[side] !== null && !present.has(change.sceneId)).length;
		return missing ? `Cannot ${direction} the agent draft: ${missing === 1 ? "a scene it changed no longer exists" : `${missing} scenes it changed no longer exist`}` : null;
	}

	execute(): CommandResult | undefined {
		const blocked = this.getBlockedReason({ direction: "redo" });
		if (blocked) throw new Error(blocked);
		this.apply("after");
		return this.selection.length ? createElementSelectionResult(this.selection) : undefined;
	}

	undo(): void {
		this.apply("before");
	}

	private apply(side: "before" | "after"): void {
		this.wrap(() => {
			const editor = EditorCore.getInstance();
			const target = new Map(this.changes.map((change) => [change.sceneId, change[side]]));
			const current = editor.scenes.getScenes();
			const kept = current.flatMap((scene) => {
				if (!target.has(scene.id)) return [scene];
				const replacement = target.get(scene.id);
				return replacement ? [replacement] : [];
			});
			const restored = this.changes.flatMap((change) => {
				const scene = change[side];
				return scene && !current.some((s) => s.id === change.sceneId) ? [scene] : [];
			});
			const scenes = [...kept, ...restored];
			const open = this.open[side];
			editor.scenes.setScenes({ scenes, activeSceneId: open && scenes.some((scene) => scene.id === open) ? open : undefined });
			const active = editor.scenes.getActiveSceneOrNull();
			if (active) editor.timeline.updateTracks(active.tracks);
		});
	}
}
