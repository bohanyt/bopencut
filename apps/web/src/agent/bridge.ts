// Every timeline change is written to AGENT_WORKSPACE/project.json (seconds, pixels),
// so the agent can see each item's location, time, and position without opening the browser.
import { draftHistory, isForOtherProject, nextSnapshotTime, snapshotHistory } from "./history";
import { changesResult, keepAnswerState } from "./changes";
import { markAnswered, wasAnswered } from "./answered";
import { defaultExportName, parseExportRequest } from "./export";
import type { ExportResult } from "@/export";
import type { MediaLoadFailure } from "@/media/types";
import { isTimelineGestureActive, subscribeTimelineGestures } from "@/timeline/gesture-state";
import { EditorCore } from "@/core";
import { calculateTotalDuration } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { storageService } from "@/services/storage/service";
import { parseSourceWords, type SourceWord } from "@/media/words";
import { toast } from "sonner";
import { pollFrames } from "./frames";
import { loadIcon } from "@/stickers/providers/iconify";
import { createEditLogger, type EditSnapshot } from "./edit-log";
import { type AgentElement, type LoadedMedia, assetKey, existingAgentMedia, loadAgentAsset } from "./elements";
import { walkAgentElements } from "./compound-content";
import { type Draft, type DraftOp, computeAgentDraft } from "./draft";
import { AgentDraftCommand } from "./draft-command";
import { getRootScene, selectionInScene } from "./scene-graph";
import { s, buildAllEditItems, buildEditItems, buildSceneSnapshot } from "./snapshot";
import { NO_SELECTION } from "./selection-payload";
import { mediaIdsInScenes } from "@/core/managers/media-manager";
import type { SaveSession } from "@/core/managers/save-manager";
import type { TProject } from "@/project/types";
import { loadTextPresets } from "@/text/presets";
import { resolveCaptionPreset } from "./captions";

export type { Draft, DraftOp } from "./draft";

/** Spoken words of the project's media files, looked up by id (built once per snapshot or draft). */
function mediaWords(): (mediaId: string) => SourceWord[] | undefined {
	const words = new Map<string, SourceWord[]>();
	for (const asset of EditorCore.getInstance().media.getAssets()) if (asset.words) words.set(asset.id, asset.words);
	return (mediaId) => words.get(mediaId);
}

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
	// Save state of the open project's own session (never of a project closed a moment ago).
	const session = editor.save.getCurrent();
	const own = session?.projectId === projectId ? session : null;
	const pendingSave = !!own?.isDirty();
	const saveError = own?.lastError ?? null;
	const savedAt = own?.savedAt?.toISOString() ?? null;
	// A session still loading (a project opening, or a new one before its first write) is not ready.
	const ready = !!project && !editor.project.getIsLoading() && !own?.isLoading() && mediaLoaded && !pendingSave && !saveError;
	return { ready, mediaLoaded, missingMedia, pendingSave, saveError, savedAt };
}

/** A drag on the timeline is in progress: a resize or trim preview, or a clip move. */
function timelineBusy(): boolean {
	return EditorCore.getInstance().timeline.isPreviewActive() || isTimelineGestureActive();
}

/** Resolves true once no timeline drag is in progress, false after `timeoutMs` (on changes, not polled). */
function whenPreviewEnds({ timeoutMs }: { timeoutMs: number }): Promise<boolean> {
	const { timeline, scenes } = EditorCore.getInstance();
	if (!timelineBusy()) return Promise.resolve(true);
	return new Promise((resolve) => {
		const finish = (ended: boolean) => {
			clearTimeout(timer);
			for (const unsubscribe of unsubscribes) unsubscribe();
			resolve(ended);
		};
		const check = () => {
			if (!timelineBusy()) finish(true);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		const unsubscribes = [timeline.subscribe(check), scenes.subscribe(check), subscribeTimelineGestures(check)];
	});
}

/** Resolves true once agentReadiness().ready, false after `timeoutMs` (checked on changes, not polled). */
export function whenAgentReady({ timeoutMs = 120000 }: { timeoutMs?: number } = {}): Promise<boolean> {
	if (agentReadiness().ready) return Promise.resolve(true);
	const editor = EditorCore.getInstance();
	return new Promise((resolve) => {
		const finish = (ready: boolean) => {
			clearTimeout(timer);
			for (const unsubscribe of unsubscribes) unsubscribe();
			resolve(ready);
		};
		const check = () => {
			if (agentReadiness().ready) finish(true);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		const unsubscribes = [editor.save.subscribe(check), editor.media.subscribe(check), editor.project.subscribe(check)];
	});
}

export function agentSnapshot() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const active = editor.scenes.getActiveSceneOrNull();
	const scene = agentRootScene();
	if (!project || !active || !scene) return null;
	const view = buildSceneSnapshot({ scenes: editor.scenes.getScenes(), rootSceneId: scene.id, mediaName: mediaNames(), wordsOf: mediaWords() });
	const { ready, mediaLoaded, missingMedia, pendingSave, saveError, savedAt } = agentReadiness();
	return {
		schema: "opencut-agent-sync-1", projectId: project.metadata.id, projectName: project.metadata.name,
		// ready = media loaded and nothing left to save; savedAt = last write of project.json; syncedAt = this snapshot.
		ready, mediaLoaded, mediaCount: editor.media.getAssets().length, missingMedia, pendingSave, saveError, savedAt, syncedAt: nextSnapshotTime(),
		canvas: project.settings.canvasSize, fps: project.settings.fps,
		note: "Times are in seconds. transform.positionX/Y = pixels from the canvas center. Overlay index 0 = topmost. Inside compounds, start/end are relative to the compound's content; visible = intervals in the root timeline.",
		sceneId: scene.id, activeSceneId: active.id,
		notes: scene.bookmarks.filter((b) => b.note?.trim()).map((b) => ({ id: b.id ?? `legacy-${b.time}`, text: b.note, start: s(b.time), ...(b.duration ? { end: s(b.time + b.duration) } : {}), elementIds: b.elementIds ?? [], replies: b.replies ?? [], author: b.author ?? "user", resolved: b.resolved ?? false, createdAt: b.createdAt ?? null })),
		tracks: view.tracks,
		compounds: view.compounds,
		selection: agentSelection(view),
	};
}

/**
 * What the user is pointing at: the selected elements (as they appear in the snapshot, with their track) and
 * the playhead (seconds, in the open scene). Agents resolve "this" from unresolved notes first, then this.
 */
export function agentSelection(view?: ReturnType<typeof buildSceneSnapshot>) {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const active = editor.scenes.getActiveSceneOrNull();
	const scene = agentRootScene();
	if (!project || !active || !scene) return null;
	const snapshot = view ?? buildSceneSnapshot({ scenes: editor.scenes.getScenes(), rootSceneId: scene.id, mediaName: mediaNames(), wordsOf: mediaWords() });
	const lanes = active.id === scene.id ? snapshot.tracks : (snapshot.compounds.find((c) => c.sceneId === active.id)?.tracks ?? []);
	const selected = editor.selection.getSelectedElements().flatMap(({ trackId, elementId }) => {
		const lane = lanes.find((l) => l.id === trackId);
		const element = lane?.elements.find((e) => e.id === elementId);
		return element && lane ? [{ ...element, track: { id: lane.id, name: lane.name, type: lane.type } }] : [];
	});
	return { projectId: project.metadata.id, sceneId: scene.id, activeSceneId: active.id, playhead: s(editor.playback.getCurrentTime()), selected };
}

function editSnapshot(): EditSnapshot | null {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const scene = agentRootScene();
	if (!project || !scene) return null;
	// Every root scene: opening another scene is not an edit, and an edit made just before is still logged.
	return { projectId: project.metadata.id, items: buildAllEditItems({ scenes: editor.scenes.getScenes(), mediaName: mediaNames() }) };
}
let editLogger: ReturnType<typeof createEditLogger> | undefined;
/** Recent snapshots sent to the agent (by syncedAt), for drafts that say what they were based on. */
export { snapshotHistory };
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
			if (!snap) return;
			// Remember what this snapshot showed, so a draft `basedOn` it can tell the user's later edits apart.
			snapshotHistory.record(snap.syncedAt, editor.scenes.getScenes(), stateMeta(snap.sceneId));
			fetch("/api/agent/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snap) }).catch(() => {});
		}, 800);
	};
	const push = () => {
		editLogger?.changed();
		sync();
	};
	editor.timeline.subscribe(push);
	editor.scenes.subscribe(push);
	// selection.json: what the user points at, written shortly after the selection or the playhead settles.
	let selectionTimer: ReturnType<typeof setTimeout> | undefined;
	let lastSelection = "";
	const pushSelection = () => {
		clearTimeout(selectionTimer);
		selectionTimer = setTimeout(() => {
			// No open project: an empty selection, so an agent never acts on a closed project's selection.
			const body = JSON.stringify(agentSelection() ?? NO_SELECTION);
			if (body === lastSelection) return;
			lastSelection = body;
			fetch("/api/agent/selection", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {
				lastSelection = "";
			});
		}, 250);
	};
	editor.selection.subscribe(pushSelection);
	editor.playback.subscribe(pushSelection);
	editor.timeline.subscribe(pushSelection);
	editor.scenes.subscribe(pushSelection);
	editor.project.subscribe(pushSelection);
	pushSelection();
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
	// A snapshot taken in the console is remembered like a synced one, so a draft can be basedOn it.
	const consoleSnapshot = () => {
		const snap = agentSnapshot();
		if (snap) snapshotHistory.record(snap.syncedAt, editor.scenes.getScenes(), stateMeta(snap.sceneId));
		return snap;
	};
	(window as any).agent = { editor, snapshot: consoleSnapshot, selection: agentSelection, push, applyDraft, ready: agentReadiness, whenReady: whenAgentReady, retryMissingMedia };
	push();
	setInterval(pollDraft, 2000);
	// Frames wait for media and saves too: otherwise a frame can miss content that is still loading.
	// One timer for frame and change requests (two small reads of the workspace every 2 s).
	setInterval(() => {
		void pollFrames(agentReadiness);
		void pollChanges();
		void pollExport();
	}, 2000);
}

export function retryMissingMedia(failures?: MediaLoadFailure[]): Promise<MediaLoadFailure[]> {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	return project ? editor.media.retryMissingMedia({ projectId: project.metadata.id, failures }) : Promise.resolve([]);
}

/**
 * Answers `export-request.json`: exports the root timeline (once per rev and project) into the workspace's
 * `exports/` folder and reports progress and the result in `export-result.json`. Exported for tests.
 */
export async function pollExport() {
	if (exporting) return;
	exporting = true;
	try {
		await answerExport();
	} finally {
		exporting = false;
	}
}

let exporting = false;
/** This tab, in the result file: the tab that took a request is the one that answers it. */
const EXPORT_TAB = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random()}`;
/** How long a small request to the editor's server may take (it is local; a stalled one is given up). */
const REQUEST_WAIT_MS = 10_000;
/** An error answer not posted yet (the server did not answer): posted again on the next poll. */
let unposted: { key: string; rev: string; body: Record<string, unknown> } | null = null;

/** Posts progress or an error; says whether it was written, or the request was answered or taken by another tab. */
async function sendExportResult(body: Record<string, unknown>): Promise<"ok" | "answered" | "claimed" | "failed"> {
	try {
		const response = await fetch("/api/agent/export-result", {
			method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, tab: EXPORT_TAB }), signal: AbortSignal.timeout(REQUEST_WAIT_MS),
		});
		if (response.ok) return "ok";
		if (response.status !== 409) return "failed";
		const reply = (await response.json().catch(() => ({}))) as { answered?: boolean };
		return reply.answered ? "answered" : "claimed";
	} catch {
		return "failed";
	}
}

async function postUnposted() {
	const answer = unposted;
	if (!answer) return;
	const sent = await sendExportResult(answer.body);
	if (sent === "failed") return;
	// "claimed": another tab took the request meanwhile; it answers.
	if (sent !== "claimed") markAnswered(answer.key, answer.rev);
	if (unposted === answer) unposted = null;
}

/** The open project when it can export now: loaded and saved, no other export, no drag in progress. */
function exportable() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const root = agentRootScene();
	if (!project || !root || timelineBusy() || editor.renderer.isExportRunning()) return null;
	return agentReadiness().ready ? { project, root } : null;
}

async function answerExport() {
	if (unposted) return await postUnposted();
	const editor = EditorCore.getInstance();
	if (!editor.project.getActiveOrNull() || editor.renderer.isExportRunning()) return;
	let raw: unknown = null;
	try {
		raw = await (await fetch("/api/agent/export-request", { cache: "no-store", signal: AbortSignal.timeout(REQUEST_WAIT_MS) })).json();
	} catch {
		return;
	}
	const rev = raw && typeof raw === "object" && typeof (raw as { rev?: unknown }).rev === "string" ? (raw as { rev: string }).rev : null;
	if (!rev || !/^[a-zA-Z0-9_-]{1,100}$/.test(rev)) return;
	const projectId = editor.project.getActiveOrNull()?.metadata.id;
	if (!projectId) return;
	if (typeof (raw as { projectId?: unknown }).projectId === "string" && (raw as { projectId: string }).projectId !== projectId) return; // another project's
	const key = `agent-export-${projectId}`;
	if (wasAnswered(key, rev)) return;
	const before = exportable();
	if (!before || before.project.metadata.id !== projectId) return;
	const answer = async (body: Record<string, unknown>) => {
		unposted = { key, rev, body: { rev, projectId, ...body } };
		await postUnposted();
	};
	const request = parseExportRequest(raw);
	if (typeof request === "string") return await answer({ status: "error", error: request });
	if (!request) return;
	const reportFailure = ({ cancelled, error, missingMedia }: ExportResult) => {
		if (missingMedia?.length) {
			return answer({
				status: "error",
				error: `${error} Restore the missing sources, pass this result's missingMedia to window.agent.retryMissingMedia() to reload stored files, then use a new rev. To export without them, send allowMissing:true with a new rev.`,
				missingMedia,
			});
		}
		return answer({ status: "error", error: cancelled ? "cancelled: the project was closed during the export" : error ?? "export failed" });
	};
	const preflight = editor.renderer.checkExport({
		format: request.format, allowMissing: request.allowMissing, includeAudio: request.includeAudio, scene: before.root,
		scenes: editor.scenes.getScenes(), canvasSize: before.project.settings.canvasSize,
	});
	if (preflight) return await reportFailure(preflight);
	// The request is taken first (another tab may be exporting it, or it may be answered already, for example
	// before a reload), then the editor is checked again: it may have changed meanwhile.
	const claim = await sendExportResult({ rev, projectId, status: "exporting", progress: 0 });
	if (claim === "answered") return markAnswered(key, rev);
	if (claim !== "ok") return;
	const now = exportable();
	if (!now || now.project.metadata.id !== projectId) return; // taken again on the next poll
	const { project, root } = now;
	const settings = project.settings;
	const fps = request.fps ? { numerator: Math.round(request.fps * 1000), denominator: 1000 } : settings.fps;
	const name = request.name ?? defaultExportName(project.metadata.name);
	const duration = calculateTotalDuration({ tracks: root.tracks }) / TICKS_PER_SECOND;
	const started = Date.now();
	// Progress: one post at a time, at most every 2 s, none once the export has ended. If the request was
	// answered or taken meanwhile (another tab), this export stops.
	let running = true;
	const claimController = new AbortController();
	let lastPost = Date.now();
	let posting: Promise<unknown> | null = null;
	const progress = (value: number) => {
		if (!running || posting || Date.now() - lastPost < 2000) return;
		lastPost = Date.now();
		posting = sendExportResult({ rev, projectId, status: "exporting", progress: Math.round(value * 1000) / 1000 })
			.then((sent) => {
				if (sent === "answered" || sent === "claimed") claimController.abort();
			})
			.finally(() => {
				posting = null;
			});
	};
	const toastId = toast.loading("Exporting a video for the agent", { description: "The export button waits until it is done" });
	let result: ExportResult;
	try {
		// No wait between the checks above and this call: the export takes the timeline as it is now. It
		// stops if the project is closed or another one opened (its media go with it).
		result = await editor.renderer.exportProject({
			options: { format: request.format, quality: request.quality, fps, includeAudio: request.includeAudio, allowMissing: request.allowMissing, sceneId: root.id },
			onProgress: ({ progress: value }) => progress(value),
			signal: claimController.signal,
		});
	} catch (error) {
		result = { success: false, error: errorText(error) };
	} finally {
		running = false;
		await posting;
		toast.dismiss(toastId);
	}
	if (claimController.signal.aborted) return;
	if (!result.success || !result.buffer) {
		return await reportFailure(result);
	}
	// The server writes the final answer together with the file.
	const done = {
		format: request.format, quality: request.quality, width: settings.canvasSize.width, height: settings.canvasSize.height,
		fps: fps.numerator / fps.denominator, duration: Math.round(duration * 1000) / 1000, seconds: Math.round((Date.now() - started) / 100) / 10,
	};
	try {
		const query = new URLSearchParams({ rev, projectId, tab: EXPORT_TAB, name, format: request.format, result: JSON.stringify(done) });
		const saved = await fetch(`/api/agent/export-file?${query}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: result.buffer });
		const reply = (await saved.json().catch(() => ({}))) as { error?: string; answered?: boolean };
		if (saved.ok || reply.answered) return markAnswered(key, rev);
		return await answer({ status: "error", error: `the file could not be saved: ${reply.error ?? saved.status}` });
	} catch (error) {
		// If the server saved it and only its reply was lost, this error is refused (the request has its answer).
		return await answer({ status: "error", error: `the file could not be saved: ${errorText(error)}` });
	}
}

/** What a kept timeline state carries besides its scenes: project, root, render settings, media names. */
function stateMeta(rootSceneId: string) {
	const project = EditorCore.getInstance().project.getActive();
	const { canvasSize, background, fps } = project.settings;
	return { projectId: project.metadata.id, rootSceneId, settings: { canvasSize, background, fps }, media: mediaNames() };
}

/**
 * Answers `changes-request.json` (what changed since a snapshot, or for a draft) into
 * `changes-result.json`, once per rev and project. Exported for tests.
 */
let changesBusy = false;
export async function pollChanges() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const root = agentRootScene();
	if (!project || !root || changesBusy || editor.project.getIsLoading() || timelineBusy()) return;
	changesBusy = true;
	try {
		let request: { rev?: unknown; since?: unknown; draft?: unknown } | null = null;
		try {
			request = await (await fetch("/api/agent/changes-request", { cache: "no-store" })).json();
		} catch {
			return;
		}
		if (!request || typeof request.rev !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.rev)) return;
		const key = `agent-changes-${project.metadata.id}`;
		if (wasAnswered(key, request.rev)) return;
		// The project read before the request may have been replaced meanwhile: answer for the open one.
		const open = editor.project.getActiveOrNull();
		const openRoot = agentRootScene();
		if (!open || open.metadata.id !== project.metadata.id || !openRoot) return;
		const now = { ...stateMeta(openRoot.id), scenes: editor.scenes.getScenes() };
		const result = changesResult({ ...request, rev: request.rev }, { now, mediaName: mediaNames() });
		if (!result) return; // for another project: left for it
		const post = (body: unknown) => fetch("/api/agent/changes-result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		let response = await post(result);
		// Stored: its state becomes a snapshot to chain from.
		if (response.ok && "syncedAt" in result && !("error" in result)) keepAnswerState(now, result.syncedAt);
		// Not stored (too large): answered with the reason instead of being worked out again every poll.
		if (!response.ok) response = await post({ rev: request.rev, projectId: open.metadata.id, error: `the answer could not be stored (${response.status}); ask with a newer since` });
		if (response.ok) markAnswered(key, request.rev);
	} catch (error) {
		console.error("Agent changes failed:", error);
	} finally {
		changesBusy = false;
	}
}

// An agent draft is a list of per-item operations, protecting human edits (see AGENT.md and draft.ts).
// Times are in seconds; inside a compound clip they are relative to its content. The whole draft is one Undo step.
let applying = false;
/** Picks up draft.json for the open project (every 2 s; exported for tests). */
export async function pollDraft() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	if (!project || applying) return;
	if (timelineBusy()) return; // a human is dragging: wait until release
	if (!agentReadiness().ready) return; // media still loading or a save pending: the draft waits
	// The session is taken before the fetch: a project opened while draft.json is read is not the
	// one this poll was for, and the draft is left for the next poll (not marked seen, not refused).
	const session = currentSession();
	const rootSceneId = agentRootScene()?.id ?? null;
	let draft: Draft | null = null;
	try {
		draft = await (await fetch("/api/agent/draft", { cache: "no-store" })).json();
	} catch {
		return;
	}
	if (!draft?.rev || (draft.projectId && draft.projectId !== project.metadata.id)) return;
	if (draftSessionError({ draft, queued: session, now: currentSession() })) return;
	// A root switch can also make the editor unready. Refuse this draft before a later poll can retarget it.
	if (rootSceneId === (agentRootScene()?.id ?? null) && !agentReadiness().ready) return;
	const key = `agent-draft-${project.metadata.id}`;
	if (localStorage.getItem(key) === draft.rev) return;
	localStorage.setItem(key, draft.rev);
	applying = true;
	try {
		await applyDraft(draft, { session, rootSceneId });
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
export function applyDraft(draft: Draft, { session = currentSession(), rootSceneId = agentRootScene()?.id ?? null }: { session?: DraftSession | null; rootSceneId?: string | null } = {}): Promise<void> {
	// A queued draft keeps its project session and root.
	const run = draftQueue.then(() => applyDraftNow(draft, session, rootSceneId));
	draftQueue = run.catch(() => {});
	return run;
}

const usedMediaIds = mediaIdsInScenes;

/** The project session a draft was queued in: its project id and the project manager's session. */
export type DraftSession = { projectId: string; session: number };

/** The project session open now, or null. */
function currentSession(): DraftSession | null {
	const editor = EditorCore.getInstance();
	const projectId = editor.project.getActiveOrNull()?.metadata.id;
	return projectId ? { projectId, session: editor.project.getSession() } : null;
}

/** Why a draft cannot run in the session open now, or null when it can. */
export function draftSessionError({ draft, queued, now }: { draft: Pick<Draft, "projectId">; queued: DraftSession | null; now: DraftSession | null }): string | null {
	if (!queued) return "no project was open when the draft was queued";
	if (!now || now.projectId !== queued.projectId || now.session !== queued.session) return "another project was opened before the draft ran; nothing was applied";
	if (draft.projectId !== undefined && draft.projectId !== null && draft.projectId !== queued.projectId) return `the draft is for project ${String(draft.projectId)}, not the open one; nothing was applied`;
	return null;
}

async function applyDraftNow(draft: Draft, session: DraftSession | null, rootSceneId: string | null) {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const active = editor.scenes.getActiveSceneOrNull();
	const refused = draftSessionError({ draft, queued: session, now: currentSession() });
	if (refused) {
		const projectId = session?.projectId ?? project?.metadata.id;
		const ops: DraftOp[] = Array.isArray(draft?.ops) ? draft.ops : [];
		toast.error(`Agent draft not applied: ${draft.label ?? draft.rev}`, { description: refused });
		await fetch("/api/agent/applied", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ rev: draft.rev, label: draft.label, appliedAt: new Date().toISOString(), projectId, ok: false, applied: false, error: refused, results: ops.map((op) => ({ op: op?.op, ...opLabel(op), ok: false, skipped: true })) }),
		}).catch(() => {});
		return;
	}
	const rootBefore = agentRootScene()?.id;
	if (!project || !active || !rootBefore) return;
	const projectId = project.metadata.id;
	const importSession = { projectId, signal: editor.project.getSessionSignal() };
	const ops: DraftOp[] = Array.isArray(draft?.ops) ? structuredClone(draft.ops) : [];
	const report = (body: Record<string, unknown>) =>
		fetch("/api/agent/applied", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ rev: draft.rev, label: draft.label, appliedAt: new Date().toISOString(), projectId, ...body }),
		}).catch(() => {});

	// A draft's base must describe the target timeline before anything is imported.
	const snapshot = typeof draft.basedOn === "string" ? snapshotHistory.state(draft.basedOn) : null;
	const base = typeof draft.basedOn === "string" ? snapshotHistory.get(draft.basedOn) : undefined;
	if (draft.basedOn !== undefined && (!snapshot || !base || snapshot.projectId !== projectId || snapshot.rootSceneId !== rootBefore)) {
		const error = typeof draft.basedOn !== "string"
			? "basedOn must be the syncedAt string of a snapshot"
			: !snapshot || !base
				? "basedOn is unknown (the editor reloaded or the snapshot is too old); re-read the snapshot and resend"
				: "basedOn belongs to a different project or root scene; re-read the snapshot and resend";
		const results = ops.map((op) => ({ op: op?.op, ...opLabel(op), ...(op && "match" in op && op.match !== undefined ? { match: op.match } : {}), ok: false, stale: true, error }));
		toast.error(`Agent draft not applied: ${draft.label ?? draft.rev}`, { description: error });
		await report({ sceneId: rootBefore, ok: false, applied: false, stale: true, error, results });
		return;
	}
	if (rootBefore !== rootSceneId) {
		const error = "another scene was opened before the draft ran; nothing was applied, resend";
		await report({ sceneId: rootBefore, ok: false, applied: false, error, results: ops.map((op) => ({ op: op?.op, ...opLabel(op), ok: false, skipped: true })) });
		return;
	}

	// Load icons and assets first (async), then change the timeline at once.
	const media = new Map<AgentElement, LoadedMedia>();
	const byPath = new Map<string, Promise<LoadedMedia>>();
	let presets: ReturnType<typeof loadTextPresets> | undefined;
	// Every import attempted, recorded before anything is written (also those whose save failed).
	const staged: string[] = [];
	const failures: (string | undefined)[] = [];
	// Element trees are walked once, before anything is imported: a malformed tree (e.g. a null element
	// inside a compound) fails its op instead of throwing after assets were staged.
	const opElements = ops.map((op): AgentElement[] | Error => {
		try {
			return elementsOf(op);
		} catch (error) {
			return error instanceof Error ? error : new Error(String(error));
		}
	});
	const elementsOfOp = (i: number): AgentElement[] => {
		const elements = opElements[i];
		return elements instanceof Error ? [] : elements;
	};
	// A file used several times is imported once: words given on any of its references go with it.
	const wordsByAsset = new Map<string, unknown>();
	for (const walked of opElements) {
		if (walked instanceof Error) continue;
		for (const e of walked) {
			if (e?.asset && typeof e.asset !== "string" && e.asset.words !== undefined && !wordsByAsset.has(assetKey(e.asset))) wordsByAsset.set(assetKey(e.asset), e.asset.words);
		}
	}
	// `words` ops are stored before the timeline changes (then a draft never reports words it could not
	// store); a draft that does not apply puts the previous words back.
	const previousWords = new Map<string, SourceWord[] | undefined>();
	/** Puts back the words of every media whose words this draft stored; what could not be put back. */
	const restoreWords = async () => {
		const failed: { id: string; error: string }[] = [];
		for (const [id, words] of previousWords) {
			try {
				await storageService.setMediaWords({ projectId, id, words });
			} catch (error) {
				failed.push({ id: `words:${id}`, error: errorText(error) });
			}
		}
		return failed;
	};
	for (const [i, op] of ops.entries()) {
		const errors: string[] = [];
		const walked = opElements[i];
		if (walked instanceof Error) {
			failures[i] = `invalid elements: ${walked.message}`;
			continue;
		}
		if (op.op === "words") {
			const target = editor.media.getAssets().find((asset) => asset.id === op.mediaId);
			const words = parseSourceWords(op.words);
			if (!target) failures[i] = `media not in project: ${String(op.mediaId)}`;
			else if (!words) failures[i] = "words must be a list of {text, start, end} in seconds";
			else {
				const before = previousWords.has(target.id) ? previousWords.get(target.id) : target.words;
				try {
					await storageService.setMediaWords({ projectId, id: target.id, words });
					// Only words that were stored are put back.
					if (!previousWords.has(target.id)) previousWords.set(target.id, before);
				} catch (error) {
					failures[i] = `words not stored: ${errorText(error)}`;
				}
			}
			continue;
		}
		if (op.op === "set" && op.caption?.preset) {
			try {
				op.caption = resolveCaptionPreset(op.caption, await (presets ??= loadTextPresets()));
			} catch (error) {
				errors.push(`caption: ${errorText(error)}`);
			}
		}
		for (const e of walked) {
			if (!e || typeof e !== "object") {
				errors.push("an element is not an object");
				continue;
			}
			try {
				if (e.caption?.preset) e.caption = resolveCaptionPreset(e.caption, await (presets ??= loadTextPresets()));
				if (e.icon) e.icon = { ...e.icon, svg: await loadIcon(e.icon.name) };
				if (e.mediaId !== undefined) {
					if (typeof e.mediaId !== "string") throw new Error("mediaId must be a string");
					media.set(e, existingAgentMedia(e));
				} else if (e.asset && typeof e.asset !== "string") {
					const asset = e.asset;
					const key = assetKey(asset);
					const withWords = wordsByAsset.has(key) ? { ...asset, words: wordsByAsset.get(key) as SourceWord[] } : asset;
					if (!byPath.has(key)) byPath.set(key, loadAgentAsset({ session: importSession, asset: withWords, stagedIds: staged }));
					media.set(e, await byPath.get(key)!);
				}
			} catch (error) {
				errors.push(`${e.agent_id ?? e.name}: ${errorText(error)}`);
			}
		}
		if (errors.length) failures[i] = errors.join("; ");
	}
	/**
	 * Removes staged imports (all, or those `keep` does not need) and reports what could not be removed.
	 * Without `keep` the draft does not apply: stored words are put back too.
	 */
	const discard = async (keep?: Set<string>) => {
		const wordsFailed = keep ? [] : await restoreWords();
		const drop = staged.filter((id) => !keep?.has(id));
		if (drop.length === 0 && wordsFailed.length === 0) return null;
		const cleanup = drop.length ? await editor.media.discardStagedMediaAssets({ ids: drop }) : { removed: [], failed: [] };
		// Words that could not be put back count as not rolled back, like files that could not be removed.
		return { ...cleanup, failed: [...cleanup.failed, ...wordsFailed] };
	};
	const cleanupNote = (cleanup: Awaited<ReturnType<typeof discard>>) => {
		const files = cleanup?.failed.filter((entry) => !entry.id.startsWith("words:")).length ?? 0;
		const words = (cleanup?.failed.length ?? 0) - files;
		return [
			files ? `; ${files} imported ${files === 1 ? "file" : "files"} could not be removed from storage` : "",
			words ? `; the words of ${words} ${words === 1 ? "media file" : "media files"} could not be put back` : "",
		].join("");
	};
	// The user started dragging while assets loaded: committing now would cancel the drag, so the draft
	// waits for the release (at most a minute).
	if (timelineBusy() && !(await whenPreviewEnds({ timeoutMs: 60000 }))) {
		const cleanup = await discard();
		await report({ ok: false, applied: false, error: "the user kept dragging on the timeline; nothing was applied, resend" + cleanupNote(cleanup), rolledBack: !cleanup?.failed.length, ...(cleanup ? { cleanup } : {}), results: ops.map((op) => ({ op: op?.op, ...opLabel(op), ok: false, skipped: true })) });
		return;
	}
	// Loading (for example a slow URL section) took a while. If another project is open now, its timeline
	// is not the one this draft was made for, and the staged imports belong to the first project: stop here.
	if (draftSessionError({ draft, queued: session, now: currentSession() })) {
		const cleanup = await discard();
		await report({ ok: false, applied: false, error: "another project was opened while the draft's assets were loading; nothing was applied" + cleanupNote(cleanup), rolledBack: !cleanup?.failed.length, ...(cleanup ? { cleanup } : {}), results: ops.map((op) => ({ op: op?.op, ...opLabel(op), ok: false, skipped: true })) });
		return;
	}
	const root = agentRootScene();
	// Another root scene was opened while the draft loaded or waited: its ops were meant for the first one.
	if (root && root.id !== rootBefore) {
		const cleanup = await discard();
		await report({ ok: false, applied: false, error: "another scene was opened before the draft applied; nothing was applied, resend" + cleanupNote(cleanup), rolledBack: !cleanup?.failed.length, ...(cleanup ? { cleanup } : {}), results: ops.map((op) => ({ op: op?.op, ...opLabel(op), ok: false, skipped: true })) });
		return;
	}
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


	const loadedWords = new Map<string, SourceWord[]>();
	for (const loaded of media.values()) if (loaded.words) loadedWords.set(loaded.id, loaded.words);
	// Read the scenes after loading: the human may have edited meanwhile.
	const before = editor.scenes.getScenes();
	const openScene = editor.scenes.getActiveScene();
	const outcome = computeAgentDraft({
		scenes: before, rootSceneId: root.id, ops, mediaFor: (e) => media.get(e), atomic: draft.atomic === true,
		canvas: project.settings.canvasSize, fps: project.settings.fps, ripple: editor.command.isRippleEnabled, base,
		// Also the words of media this draft imports (a later set can cut by them).
		wordsOf: ((project) => (id: string) => loadedWords.get(id) ?? project(id))(mediaWords()),
	});
	// The open scene stays open unless the draft removed it (ungrouping the compound being edited): then the root opens.
	const openAfter = outcome.scenes.some((scene) => scene.id === openScene.id) ? openScene.id : root.id;
	// Select changed or added items so they are visible on the timeline (inside history, so redo selects them again).
	const selection = selectionInScene(outcome.scenes, openAfter, outcome.touched);
	let error: string | null = outcome.applied ? null : "an op of this atomic draft failed; nothing was applied";
	// Every op failed (for example all were stale): nothing changed, so nothing is applied or saved.
	const stale = outcome.results.some((result) => result?.stale === true);
	if (!error && outcome.results.length > 0 && !outcome.results.some((result) => result?.ok)) {
		error = stale ? "every op was stale; nothing was applied (re-read the snapshot and resend)" : "no op could be applied; nothing was applied";
	}
	// Media reused by `mediaId` must still be in the project (the human may have deleted it while assets loaded).
	const present = new Set(editor.media.getAssets().map((asset) => asset.id));
	const gone = [...media.entries()].filter(([e, loaded]) => e.mediaId !== undefined && !present.has(loaded.id)).map(([e]) => e.mediaId);
	if (!error && gone.length) error = `media no longer in the project: ${gone.join(", ")}; nothing was applied`;
	// Staged imports the result uses; the others (only used by failed ops) are removed.
	const used = usedMediaIds(outcome.scenes);
	const publish = staged.filter((id) => used.has(id));
	let saveSession: SaveSession | null = null;
	let revision = 0;
	let written: Promise<TProject | null> = Promise.resolve(null);
	if (!error) {
		try {
			const command = new AgentDraftCommand({ before, after: outcome.scenes, selection, openBefore: openScene.id, openAfter, wrap: (action) => (editLogger ? editLogger.agent(action) : action()) });
			// Published in the same task as the commit (no await in between), so nothing else can
			// pick them up first, and the timeline never shows clips without their media.
			editor.media.publishStagedMediaAssets({ ids: publish });
			try {
				if (command.getChangedSceneIds().length) editor.command.execute({ command });
				// What the draft changed, for changes and before/after frames (`{draft: rev}`).
				draftHistory.record(draft.rev, { ...stateMeta(root.id), scenes: before }, { ...stateMeta(root.id), scenes: editor.scenes.getScenes() });
			} catch (e) {
				editor.media.unpublishMediaAssets({ projectId, ids: publish });
				throw e;
			}
			// Same task as the commit: the open session is the draft's project (checked above), and the
			// revision counts the commit even when saving cannot start yet.
			const current = editor.save.getCurrent();
			saveSession = current?.projectId === projectId && current.session === session?.session ? current : null;
			revision = saveSession?.markDirty({ force: true }) ?? 0;
			// Waited for from here: a write that lands while the cleanup below runs still counts.
			if (saveSession) written = saveSession.whenSaved(revision);
		} catch (e) {
			error = errorText(e);
		}
	}
	if (error) {
		const cleanup = await discard();
		toast.error(`Agent draft not applied: ${draft.label ?? draft.rev}`, { description: error + cleanupNote(cleanup) });
		await report({ sceneId: root.id, ok: false, applied: false, ...(stale ? { stale: true } : {}), error: error + cleanupNote(cleanup), rolledBack: !cleanup?.failed.length, ...(cleanup ? { cleanup } : {}), results: outcome.results });
		return;
	}
	const cleanup = await discard(new Set(publish));
	// Words the draft set (already stored) are the media's words in the editor from now on.
	for (const [mediaId, words] of outcome.words) editor.media.setMediaWords({ id: mediaId, words });

	// Report where `url` and `sfx` assets were saved and their sources (for credits and reuse as `path`).
	for (const [i, op] of ops.entries()) {
		const retrieved = elementsOfOp(i).flatMap((e) => media.get(e)?.retrieved ?? []);
		const sfx = elementsOfOp(i).flatMap((e) => media.get(e)?.sfx ?? []);
		const music = elementsOfOp(i).flatMap((e) => media.get(e)?.music ?? []);
		if (outcome.results[i] && (retrieved.length || sfx.length || music.length)) {
			outcome.results[i] = { ...outcome.results[i], ...(retrieved.length ? { retrieved } : {}), ...(sfx.length ? { sfx } : {}), ...(music.length ? { music } : {}) };
		}
	}

	// The result is written once the change is on disk: a write of the draft's own project (its save
	// session) that contains the commit. A session is per opened project, so a project opened meanwhile
	// can neither make this look saved nor take its write.
	if (!saveSession) {
		await report({ sceneId: root.id, applied: true, saved: false, saveError: "no save session for the project", ...(cleanup ? { cleanup } : {}), results: outcome.results });
		return;
	}
	const ownSession: SaveSession = saveSession;
	// Promoted once a write that contains the commit is on disk, also if that is a later retry: before
	// that, another tab loading the project would see media its saved timeline does not use yet.
	// Only imports the written timeline uses: one undone before the write stays staged.
	const promotion = written.then(async (project) => {
		if (!project || publish.length === 0) return;
		const inUse = usedMediaIds(project.scenes ?? []);
		const ids = publish.filter((id) => inUse.has(id));
		if (ids.length === 0) return;
		const promoteError = await editor.media.promotePublishedMediaAssets({ projectId, ids });
		if (promoteError) console.warn("Staged media not promoted (they still load because the timeline uses them):", promoteError);
	});
	const saved = await ownSession.settle(revision);
	if (saved) await promotion;
	const failed = outcome.results.filter((r) => !r?.ok).length;
	const description = `${outcome.results.length - failed} changes${failed ? `, ${failed} failed` : ""} · changed items selected · Ctrl+Z to undo`;
	const saveError = saved ? null : (ownSession.lastError ?? (!editor.save.isRunning() ? "saving is off" : ownSession.isLoading() ? "the project is still loading" : editor.save.getCurrent() === ownSession ? "save did not finish" : "save did not finish; it is retried in the background"));
	if (!saved) toast.error(`Agent draft applied but not saved: ${draft.label ?? draft.rev}`, { description: saveError ?? undefined });
	else if (failed) toast.warning(`Agent draft partly applied: ${draft.label ?? draft.rev}`, { description });
	else toast(`Agent draft applied: ${draft.label ?? draft.rev}`, { description });
	await report({ sceneId: root.id, applied: true, saved, savedAt: ownSession.savedAt?.toISOString() ?? null, ...(saved ? {} : { saveError }), ...(cleanup ? { cleanup } : {}), results: outcome.results });
}
