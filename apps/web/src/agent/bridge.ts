// Every timeline change is written to AGENT_WORKSPACE/project.json (seconds, pixels),
// so the agent can see each item's location, time, and position without opening the browser.
import { EditorCore } from "@/core";
import { toast } from "sonner";
import { pollFrames } from "./frames";
import { loadIcon } from "@/stickers/providers/iconify";
import { createEditLogger, type EditSnapshot } from "./edit-log";
import { type AgentElement, type LoadedMedia, loadAgentAsset } from "./elements";
import { walkAgentElements } from "./compound-content";
import { type Draft, type DraftOp, computeAgentDraft } from "./draft";
import { AgentDraftCommand } from "./draft-command";
import { getRootScene, selectionInScene } from "./scene-graph";
import { s, buildEditItems, buildSceneSnapshot } from "./snapshot";

export type { Draft, DraftOp } from "./draft";

function mediaNames() {
	return new Map(EditorCore.getInstance().media.getAssets().map((m) => [m.id, m.name]));
}

/** The root timeline the agent reads and edits (the open scene, or the user scene around the open compound). */
export function agentRootScene() {
	const editor = EditorCore.getInstance();
	return getRootScene(editor.scenes.getScenes(), editor.scenes.getActiveSceneOrNull()?.id ?? null);
}

export function agentSnapshot() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const active = editor.scenes.getActiveSceneOrNull();
	const scene = agentRootScene();
	if (!project || !active || !scene) return null;
	const view = buildSceneSnapshot({ scenes: editor.scenes.getScenes(), rootSceneId: scene.id, mediaName: mediaNames() });
	return {
		schema: "opencut-agent-sync-1", projectId: project.metadata.id, projectName: project.metadata.name, savedAt: new Date().toISOString(),
		canvas: project.settings.canvasSize, fps: project.settings.fps,
		note: "Times are in seconds. transform.positionX/Y = pixels from the canvas center. Overlay index 0 = topmost. Inside compounds, start/end are relative to the compound's content; visible = intervals in the root timeline.",
		sceneId: scene.id, activeSceneId: active.id,
		notes: scene.bookmarks.filter((b) => b.note?.trim()).map((b) => ({ id: b.id ?? `legacy-${b.time}`, text: b.note, start: s(b.time), ...(b.duration ? { end: s(b.time + b.duration) } : {}), elementIds: b.elementIds ?? [], replies: b.replies ?? [], author: b.author ?? "user", resolved: b.resolved ?? false, createdAt: b.createdAt ?? null })),
		tracks: view.tracks,
		compounds: view.compounds,
	};
}

function editSnapshot(): EditSnapshot | null {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const scene = agentRootScene();
	if (!project || !scene) return null;
	return { projectId: project.metadata.id, items: buildEditItems({ scenes: editor.scenes.getScenes(), rootSceneId: scene.id, mediaName: mediaNames() }) };
}
let editLogger: ReturnType<typeof createEditLogger> | undefined;
let installed = false;
export function installAgentBridge() {
	if (installed || typeof window === "undefined") return;
	installed = true;
	const editor = EditorCore.getInstance();
	let timer: ReturnType<typeof setTimeout> | undefined;
	editLogger = createEditLogger(editSnapshot, () => editor.timeline.isPreviewActive(), (lines) => {
		fetch("/api/agent/edits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(lines) }).catch(() => {});
	});
	const push = () => {
		editLogger?.changed();
		clearTimeout(timer);
		timer = setTimeout(() => {
			const snap = agentSnapshot();
			if (snap) fetch("/api/agent/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snap) }).catch(() => {});
		}, 800);
	};
	editor.timeline.subscribe(push);
	editor.scenes.subscribe(push);
	(window as any).agent = { editor, snapshot: agentSnapshot, push, applyDraft };
	push();
	setInterval(pollDraft, 2000);
	setInterval(pollFrames, 2000);
}

// An agent draft is a list of per-item operations, protecting human edits (see AGENT.md and draft.ts).
// Times are in seconds; inside a compound clip they are relative to its content. The whole draft is one Undo step.
let applying = false;
async function pollDraft() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	if (!project || applying) return;
	if (editor.timeline.isPreviewActive()) return; // a human is dragging: wait until release
	let draft: Draft | null = null;
	try {
		draft = await (await fetch("/api/agent/draft", { cache: "no-store" })).json();
	} catch {
		return;
	}
	if (!draft?.rev || (draft.projectId && draft.projectId !== project.metadata.id)) return;
	const key = `agent-draft-${project.metadata.id}`;
	if (localStorage.getItem(key) === draft.rev) return;
	localStorage.setItem(key, draft.rev);
	applying = true;
	try {
		await applyDraft(draft);
	} finally {
		applying = false;
	}
}

/** Elements an op builds (with compound content), whose icons and assets load before the timeline changes. */
function elementsOf(op: DraftOp): AgentElement[] {
	if (op?.op === "add") return op.element ? [...walkAgentElements([op.element])] : [];
	if (op?.op === "compound") return [...walkAgentElements([...(op.main ?? []), ...(op.overlay ?? []).flatMap((t) => t.elements ?? []), ...(op.audio ?? []), ...(op.elements ?? [])])];
	return [];
}

export async function applyDraft(draft: Draft) {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const active = editor.scenes.getActiveSceneOrNull();
	if (!project || !active || !agentRootScene()) return;
	const ops: DraftOp[] = Array.isArray(draft.ops) ? structuredClone(draft.ops) : [];
	const results: any[] = [];

	// Load icons and assets first (async), then change the timeline at once.
	const media = new Map<AgentElement, LoadedMedia>();
	const byPath = new Map<string, Promise<LoadedMedia>>();
	for (const [i, op] of ops.entries()) {
		try {
			for (const e of elementsOf(op)) {
				if (e.icon) e.icon = { ...e.icon, svg: await loadIcon(e.icon.name) };
				if (e.asset && typeof e.asset !== "string") {
					const asset = e.asset;
					if (!byPath.has(asset.path)) byPath.set(asset.path, loadAgentAsset({ projectId: project.metadata.id, asset }));
					media.set(e, await byPath.get(asset.path)!);
				}
			}
		} catch (error) {
			results[i] = { op: op.op, ...(op.op === "add" ? { name: op.element?.name } : { agentId: (op as { agent_id?: string }).agent_id }), ok: false, error: String(error) };
		}
	}

	// Read the scenes after loading: the human may have edited meanwhile.
	const before = editor.scenes.getScenes();
	const openScene = editor.scenes.getActiveScene();
	const root = agentRootScene();
	if (!root) return;
	const outcome = computeAgentDraft({
		scenes: before, rootSceneId: root.id, ops, mediaFor: (e) => media.get(e), results,
		canvas: project.settings.canvasSize, fps: project.settings.fps, ripple: editor.command.isRippleEnabled,
	});
	// Select changed or added items so they are visible on the timeline (inside history, so redo selects them again).
	const selection = selectionInScene(outcome.scenes, root.id, openScene.id, outcome.touched);
	let error: string | null = null;
	try {
		const command = new AgentDraftCommand({ before, after: outcome.scenes, selection, wrap: (action) => (editLogger ? editLogger.agent(action) : action()) });
		if (command.getChangedSceneIds().length) editor.command.execute({ command });
	} catch (e) {
		error = e instanceof Error ? e.message : String(e);
	}

	const failed = outcome.results.filter((r) => !r?.ok).length;
	if (error) toast.error(`Agent draft not applied: ${draft.label ?? draft.rev}`, { description: error });
	else toast(`Agent draft applied: ${draft.label ?? draft.rev}`, {
		description: `${outcome.results.length - failed} changes${failed ? `, ${failed} skipped` : ""} · changed items selected · Ctrl+Z to undo`,
	});
	fetch("/api/agent/applied", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ rev: draft.rev, label: draft.label, appliedAt: new Date().toISOString(), projectId: project.metadata.id, sceneId: root.id, ...(error ? { ok: false, error } : {}), results: outcome.results }),
	}).catch(() => {});
}
