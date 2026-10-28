import { Command } from "@/commands/base-command";
import { EditorCore } from "@/core";
import { updateSceneInArray } from "@/timeline/scenes";
import type { Bookmark } from "@/timeline";

export class AgentNotesCommand extends Command {
	private saved: Bookmark[] = [];
	constructor(private readonly next: Bookmark[]) { super(); }
	execute() {
		const editor = EditorCore.getInstance();
		const scene = editor.scenes.getActiveScene();
		this.saved = scene.bookmarks;
		editor.scenes.setScenes({ scenes: updateSceneInArray({ scenes: editor.scenes.getScenes(), sceneId: scene.id, updates: { bookmarks: this.next } }) });
		return undefined;
	}
	undo() {
		const editor = EditorCore.getInstance();
		const scene = editor.scenes.getActiveScene();
		editor.scenes.setScenes({ scenes: updateSceneInArray({ scenes: editor.scenes.getScenes(), sceneId: scene.id, updates: { bookmarks: this.saved } }) });
	}
}
