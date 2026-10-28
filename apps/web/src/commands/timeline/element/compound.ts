import { Command, createElementSelectionResult, type CommandResult } from "@/commands/base-command";
import { EditorCore } from "@/core";
import type { ElementRef, TScene } from "@/timeline";
import {
	buildCompoundFromElements,
	renameCompoundScene,
	ungroupCompoundElement,
} from "@/timeline/compound";

// Both commands swap the whole scene list (host tracks + nested scene) in one undo step.
abstract class ScenesChangeCommand extends Command {
	override readonly ripples = false;
	private before: TScene[] | null = null;
	private after: TScene[] | null = null;
	private hostSceneId: string | null = null;
	protected selection: ElementRef[] = [];

	protected abstract compute({
		scenes,
		hostSceneId,
	}: {
		scenes: TScene[];
		hostSceneId: string;
	}): TScene[];

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.before = editor.scenes.getScenes();
		this.hostSceneId ??= editor.scenes.getActiveScene().id;
		// Redo replays the first result so ids stay stable.
		this.after ??= this.compute({
			scenes: this.before,
			hostSceneId: this.hostSceneId,
		});
		this.apply(this.after);
		return createElementSelectionResult(this.selection);
	}

	undo(): void {
		if (this.before) this.apply(this.before);
	}

	private apply(scenes: TScene[]): void {
		const editor = EditorCore.getInstance();
		const hostSceneId = this.hostSceneId ?? undefined;
		editor.scenes.setScenes({ scenes, activeSceneId: hostSceneId });
		const host = scenes.find((scene) => scene.id === hostSceneId);
		if (host) editor.timeline.updateTracks(host.tracks);
	}
}

export class CreateCompoundCommand extends ScenesChangeCommand {
	private sceneId = "";

	constructor(
		private params: { elements: ElementRef[]; name?: string },
	) {
		super();
	}

	protected compute({
		scenes,
		hostSceneId,
	}: {
		scenes: TScene[];
		hostSceneId: string;
	}): TScene[] {
		const result = buildCompoundFromElements({
			scenes,
			hostSceneId,
			elements: this.params.elements,
			name: this.params.name,
		});
		this.selection = [result.compound];
		this.sceneId = result.sceneId;
		return result.scenes;
	}

	getCompound(): ElementRef | null {
		return this.selection[0] ?? null;
	}

	getSceneId(): string {
		return this.sceneId;
	}
}

export class UngroupCompoundCommand extends ScenesChangeCommand {
	constructor(private ref: ElementRef) {
		super();
	}

	protected compute({
		scenes,
		hostSceneId,
	}: {
		scenes: TScene[];
		hostSceneId: string;
	}): TScene[] {
		const result = ungroupCompoundElement({
			scenes,
			hostSceneId,
			ref: this.ref,
		});
		this.selection = result.elements;
		return result.scenes;
	}

	getElements(): ElementRef[] {
		return this.selection;
	}
}

/** Renames the nested scene and every compound clip showing it. Keeps the current selection. */
export class RenameCompoundCommand extends ScenesChangeCommand {
	constructor(private params: { sceneId: string; name: string }) {
		super();
	}

	override execute(): CommandResult | undefined {
		super.execute();
		return undefined;
	}

	protected compute({ scenes }: { scenes: TScene[]; hostSceneId: string }): TScene[] {
		return renameCompoundScene({
			scenes,
			sceneId: this.params.sceneId,
			name: this.params.name,
		});
	}
}
