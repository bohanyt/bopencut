// Every timeline change is written to AGENT_WORKSPACE/project.json (seconds, pixels),
// so the agent can see each item's location, time, and position without opening the browser.
import { EditorCore } from "@/core";
import { toast } from "sonner";
import { pollFrames } from "./frames";
import { loadIcon } from "@/stickers/providers/iconify";
import { createEditLogger, type EditSnapshot } from "./edit-log";
import { type AgentElement, type LoadedMedia, existingAgentMedia, stageAgentAsset } from "./elements";
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

/**
 * Whether the editor is safe for the agent: the project is loaded, loading its stored media has
 * finished, and every change is saved to disk. Drafts and frame requests wait for it; the sync
 * snapshot reports it. Stored media that could not be read do not block readiness: they are listed
 * in `missingMedia` so the agent can decide (frames refuse them unless the request allows it).
 */
export function agentReadiness() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const projectId = project?.metadata.id ?? null;
	const mediaLoaded = !!projectId && editor.media.isProjectMediaLoaded({ projectId });
	const missingMedia = mediaLoaded ? editor.media.getMissingMedia() : [];
	const pendingSave = editor.save.getIsDirty();
	const saveError = projectId ? editor.save.getLastError(projectId) : null;
	const savedAt = (projectId && editor.save.getLastSavedAt(projectId)?.toISOString()) || null;
	const ready = !!project && !editor.project.getIsLoading() && mediaLoaded && !pendingSave && !saveError;
	return { ready, mediaLoaded, missingMedia, pendingSave, saveError, savedAt };
}

/** Resolves true once agentReadiness().ready, false after `timeoutMs`. */
export async function whenAgentReady({ timeoutMs = 120000 }: { timeoutMs?: number } = {}): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!agentReadiness().ready) {
		if (Date.now() > deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return true;
}

export function agentSnapshot() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const active = editor.scenes.getActiveSceneOrNull();
	const scene = agentRootScene();
	if (!project || !active || !scene) return null;
	const view = buildSceneSnapshot({ scenes: editor.scenes.getScenes(), rootSceneId: scene.id, mediaName: mediaNames() });
	const { ready, mediaLoaded, missingMedia, pendingSave, saveError, savedAt } = agentReadiness();
	return {
		schema: "opencut-agent-sync-1", projectId: project.metadata.id, projectName: project.metadata.name,
		// ready = media loaded and nothing left to save; savedAt = last write of project.json; syncedAt = this snapshot.
		ready, mediaLoaded, mediaCount: editor.media.getAssets().length, missingMedia, pendingSave, saveError, savedAt, syncedAt: new Date().toISOString(),
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
	const sync = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			const snap = agentSnapshot();
			if (snap) fetch("/api/agent/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snap) }).catch(() => {});
		}, 800);
	};
	const push = () => {
		editLogger?.changed();
		sync();
	};
	editor.timeline.subscribe(push);
	editor.scenes.subscribe(push);
	// Re-sync when readiness changes (media finished loading, a save landed) so the snapshot tells the truth.
	let readiness = "";
	const readinessChanged = () => {
		const { ready, mediaLoaded, missingMedia, pendingSave, saveError } = agentReadiness();
		const key = JSON.stringify([ready, mediaLoaded, missingMedia.length, pendingSave, saveError]);
		if (key !== readiness) {
			readiness = key;
			sync();
		}
	};
	editor.save.subscribe(readinessChanged);
	editor.media.subscribe(readinessChanged);
	editor.project.subscribe(readinessChanged);
	const retryMissingMedia = () => {
		const project = editor.project.getActiveOrNull();
		return project ? editor.media.retryMissingMedia({ projectId: project.metadata.id }) : Promise.resolve([]);
	};
	(window as any).agent = { editor, snapshot: agentSnapshot, push, applyDraft, ready: agentReadiness, whenReady: whenAgentReady, retryMissingMedia };
	push();
	setInterval(pollDraft, 2000);
	// Frames wait for media and saves too: otherwise a frame can miss content that is still loading.
	setInterval(() => {
		void framesGate().then((go) => (go ? pollFrames() : undefined));
	}, 2000);
}

// A frame request is refused (once per rev, with an error result) while stored media are
// missing, unless it says `allowMissing: true`: frames would silently lack that content.
let refusedFramesRev: string | null = null;
async function framesGate(): Promise<boolean> {
	const { ready, missingMedia } = agentReadiness();
	if (!ready) return false;
	if (missingMedia.length === 0) return true;
	let request: { rev?: unknown; allowMissing?: unknown } | null = null;
	try {
		request = await (await fetch("/api/agent/frames-request", { cache: "no-store" })).json();
	} catch {
		return false;
	}
	if (!request || typeof request.rev !== "string") return false;
	if (request.allowMissing === true) return true;
	if (refusedFramesRev !== request.rev) {
		refusedFramesRev = request.rev;
		const projectId = EditorCore.getInstance().project.getActiveOrNull()?.metadata.id;
		await fetch("/api/agent/frames-result", {
			method: "POST", headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ rev: request.rev, projectId, files: [], error: `${missingMedia.length} stored media could not be loaded; retry them (window.agent.retryMissingMedia()) or send allowMissing:true`, missingMedia }),
		}).catch(() => {});
	}
	return false;
}

// An agent draft is a list of per-item operations, protecting human edits (see AGENT.md and draft.ts).
// Times are in seconds; inside a compound clip they are relative to its content. The whole draft is one Undo step.
let applying = false;
async function pollDraft() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	if (!project || applying) return;
	if (editor.timeline.isPreviewActive()) return; // a human is dragging: wait until release
	if (!agentReadiness().ready) return; // media still loading or a save pending: the draft waits
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

// Drafts run one at a time, whoever calls applyDraft (the poller or the console).
let draftQueue: Promise<void> = Promise.resolve();

/** Elements an op builds (with compound content), whose icons and assets load before the timeline changes. */
function elementsOf(op: DraftOp): AgentElement[] {
	if (op?.op === "add") return op.element ? [...walkAgentElements([op.element])] : [];
	if (op?.op === "replace") return op.element && typeof op.element === "object" ? [...walkAgentElements([op.element as AgentElement])] : [];
	if (op?.op === "compound") return [...walkAgentElements([...(op.main ?? []), ...(op.overlay ?? []).flatMap((t) => t.elements ?? []), ...(op.audio ?? []), ...(op.elements ?? [])])];
	return [];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const opLabel = (op: DraftOp) => (op?.op === "add" ? { name: op.element?.name } : { agentId: (op as { agent_id?: string })?.agent_id });

/**
 * Applies a draft as one Undo step; drafts run one after another. Every icon and asset (and every
 * `mediaId`) is loaded before the timeline changes, and imported assets stay private (staged) until
 * the draft commits: if anything fails, nothing is applied, the staged imports are deleted (nothing
 * can be using them), and every failure is reported, including files that could not be removed.
 * Once applied, the project is saved before the result is written, so `draft-result.json` with
 * `saved: true` means the change is in project.json on disk.
 */
export function applyDraft(draft: Draft): Promise<void> {
	const run = draftQueue.then(() => applyDraftNow(draft));
	draftQueue = run.catch(() => {});
	return run;
}

/** Media ids used by elements anywhere in these scenes. */
function usedMediaIds(scenes: { tracks: { main: { elements: unknown[] }; overlay: { elements: unknown[] }[]; audio: { elements: unknown[] }[] } }[]): Set<string> {
	const ids = new Set<string>();
	for (const scene of scenes) {
		for (const track of [scene.tracks.main, ...scene.tracks.overlay, ...scene.tracks.audio]) {
			for (const element of track.elements as { mediaId?: unknown }[]) if (typeof element.mediaId === "string") ids.add(element.mediaId);
		}
	}
	return ids;
}

async function applyDraftNow(draft: Draft) {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const active = editor.scenes.getActiveSceneOrNull();
	if (!project || !active || !agentRootScene()) return;
	const projectId = project.metadata.id;
	const ops: DraftOp[] = Array.isArray(draft?.ops) ? structuredClone(draft.ops) : [];
	const report = (body: Record<string, unknown>) =>
		fetch("/api/agent/applied", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ rev: draft.rev, label: draft.label, appliedAt: new Date().toISOString(), projectId, ...body }),
		}).catch(() => {});

	// Load icons and assets first (async), then change the timeline at once.
	const media = new Map<AgentElement, LoadedMedia>();
	const byPath = new Map<string, Promise<LoadedMedia>>();
	// Every import attempted, recorded before anything is written (also those whose save failed).
	const staged: string[] = [];
	const failures: (string | undefined)[] = [];
	for (const [i, op] of ops.entries()) {
		const errors: string[] = [];
		for (const e of elementsOf(op)) {
			try {
				if (e.icon) e.icon = { ...e.icon, svg: await loadIcon(e.icon.name) };
				if (e.mediaId !== undefined) {
					if (typeof e.mediaId !== "string") throw new Error("mediaId must be a string");
					media.set(e, existingAgentMedia(e));
				} else if (e.asset && typeof e.asset !== "string") {
					const asset = e.asset;
					if (!byPath.has(asset.path)) byPath.set(asset.path, stageAgentAsset({ projectId, asset, onId: (id) => staged.push(id) }));
					media.set(e, await byPath.get(asset.path)!);
				}
			} catch (error) {
				errors.push(`${e.agent_id ?? e.name}: ${errorText(error)}`);
			}
		}
		if (errors.length) failures[i] = errors.join("; ");
	}
	/** Removes staged imports (all, or those `keep` does not need) and reports what could not be removed. */
	const discard = async (keep: Set<string> = new Set()) => {
		const drop = staged.filter((id) => !keep.has(id));
		if (drop.length === 0) return null;
		const cleanup = await editor.media.discardStagedMediaAssets({ ids: drop });
		return cleanup;
	};
	const cleanupNote = (cleanup: Awaited<ReturnType<typeof discard>>) =>
		cleanup?.failed.length ? `; ${cleanup.failed.length} imported ${cleanup.failed.length === 1 ? "file" : "files"} could not be removed from storage` : "";
	const root = agentRootScene();
	if (failures.some(Boolean) || !root) {
		const cleanup = await discard();
		const count = failures.filter(Boolean).length;
		const results = ops.map((op, i) => ({ op: op?.op, ...opLabel(op), ok: false, ...(failures[i] ? { error: failures[i] } : { skipped: true, error: "not applied: assets of another op failed to load" }) }));
		const error = (root ? "assets failed to load; nothing was applied" : "no scene") + cleanupNote(cleanup);
		toast.error(`Agent draft not applied: ${draft.label ?? draft.rev}`, {
			description: (root ? `${count} ${count === 1 ? "op" : "ops"} could not load assets; nothing changed (see draft-result.json)` : "No scene is open") + cleanupNote(cleanup),
		});
		await report({ ...(root ? { sceneId: root.id } : {}), ok: false, applied: false, error, rolledBack: !cleanup?.failed.length, ...(cleanup ? { cleanup } : {}), results });
		return;
	}

	// Read the scenes after loading: the human may have edited meanwhile.
	const before = editor.scenes.getScenes();
	const openScene = editor.scenes.getActiveScene();
	const outcome = computeAgentDraft({
		scenes: before, rootSceneId: root.id, ops, mediaFor: (e) => media.get(e), atomic: draft.atomic === true,
		canvas: project.settings.canvasSize, fps: project.settings.fps, ripple: editor.command.isRippleEnabled,
	});
	// The open scene stays open unless the draft removed it (ungrouping the compound being edited): then the root opens.
	const openAfter = outcome.scenes.some((scene) => scene.id === openScene.id) ? openScene.id : root.id;
	// Select changed or added items so they are visible on the timeline (inside history, so redo selects them again).
	const selection = selectionInScene(outcome.scenes, openAfter, outcome.touched);
	let error: string | null = outcome.applied ? null : "an op of this atomic draft failed; nothing was applied";
	// Staged imports the result uses; the others (only used by failed ops) are removed.
	const used = usedMediaIds(outcome.scenes);
	const publish = staged.filter((id) => used.has(id));
	if (outcome.applied) {
		try {
			const command = new AgentDraftCommand({ before, after: outcome.scenes, selection, openBefore: openScene.id, openAfter, wrap: (action) => (editLogger ? editLogger.agent(action) : action()) });
			// Published in the same task as the commit (no await in between), so nothing else can
			// pick them up first, and the timeline never shows clips without their media.
			editor.media.publishStagedMediaAssets({ ids: publish });
			try {
				if (command.getChangedSceneIds().length) editor.command.execute({ command });
			} catch (e) {
				editor.media.unpublishMediaAssets({ projectId, ids: publish });
				throw e;
			}
		} catch (e) {
			error = errorText(e);
		}
	}
	if (error) {
		const cleanup = await discard();
		toast.error(`Agent draft not applied: ${draft.label ?? draft.rev}`, { description: error + cleanupNote(cleanup) });
		await report({ sceneId: root.id, ok: false, applied: false, error: error + cleanupNote(cleanup), rolledBack: !cleanup?.failed.length, ...(cleanup ? { cleanup } : {}), results: outcome.results });
		return;
	}
	const cleanup = await discard(new Set(publish));

	// The result is written once the change is on disk.
	const saved = await editor.save.settle();
	const failed = outcome.results.filter((r) => !r?.ok).length;
	const description = `${outcome.results.length - failed} changes${failed ? `, ${failed} failed` : ""} · changed items selected · Ctrl+Z to undo`;
	if (!saved) toast.error(`Agent draft applied but not saved: ${draft.label ?? draft.rev}`, { description: editor.save.getLastError() ?? "Save did not finish" });
	else if (failed) toast.warning(`Agent draft partly applied: ${draft.label ?? draft.rev}`, { description });
	else toast(`Agent draft applied: ${draft.label ?? draft.rev}`, { description });
	await report({ sceneId: root.id, applied: true, saved, savedAt: agentReadiness().savedAt, ...(saved ? {} : { saveError: editor.save.getLastError() }), ...(cleanup ? { cleanup } : {}), results: outcome.results });
}
