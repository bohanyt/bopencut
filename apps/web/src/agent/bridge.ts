// Setiap perubahan timeline ditulis ke AGENT_WORKSPACE/project.json (detik, piksel),
// supaya agen tahu lokasi/waktu/posisi tiap item tanpa membuka browser.
import { EditorCore } from "@/core";
import { TICKS_PER_SECOND } from "@/wasm";
import { toast } from "sonner";
import { BatchCommand } from "@/commands";
import { Command } from "@/commands/base-command";
import { UpsertKeyframeCommand } from "@/commands/timeline";
import type { SceneTracks } from "@/timeline/types";
import { generateUUID } from "@/utils/id";
import { type AgentElement, type LoadedMedia, type PendingKeyframe, buildAgentElement, loadAgentAsset, secs } from "./elements";

const s = (ticks: unknown) => (typeof ticks === "number" ? Math.round((ticks / TICKS_PER_SECOND) * 1000) / 1000 : ticks);

export function agentSnapshot() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!project || !scene) return null;
	const mediaName = new Map(editor.media.getAssets().map((m) => [m.id, m.name]));
	const lane = (track: any, group: string, index: number) => ({
		group, index, id: track.id, name: track.name, type: track.type, hidden: track.hidden ?? false, muted: track.muted ?? false,
		elements: track.elements.map((e: any) => ({
			id: e.id, agentId: e.agentId ?? null, type: e.type, name: e.name, media: e.mediaId ? mediaName.get(e.mediaId) ?? null : null,
			start: s(e.startTime), duration: s(e.duration), end: s(e.startTime + e.duration), trimStart: s(e.trimStart), trimEnd: s(e.trimEnd),
			effectType: e.effectType ?? null, params: e.params, hasKeyframes: !!e.animations && Object.keys(e.animations).length > 0,
		})),
	});
	const t = scene.tracks;
	return {
		schema: "opencut-agent-sync-1", projectId: project.metadata.id, projectName: project.metadata.name, savedAt: new Date().toISOString(),
		canvas: project.settings.canvasSize, fps: project.settings.fps,
		note: "Waktu dalam detik. transform.positionX/Y = piksel dari pusat kanvas. overlay index 0 = paling atas.",
		tracks: [...t.overlay.map((x, i) => lane(x, "overlay", i)), lane(t.main, "main", 0), ...t.audio.map((x, i) => lane(x, "audio", i))],
	};
}

let installed = false;
export function installAgentBridge() {
	if (installed || typeof window === "undefined") return;
	installed = true;
	const editor = EditorCore.getInstance();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const push = () => {
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
}

// Draf agen = daftar operasi per item (bukan proyek utuh), supaya editan manusia tidak tertimpa.
// { schema:"opencut-agent-draft-1", rev, label, projectId?, ops:[
//   {op:"set", match:{agentId}|{id}, start?, duration?, trimStart?, params?},
//   {op:"delete", match:{agentId}|{id}},
//   {op:"add", track:{name, type?:"video"|"audio"|"effect", index?}, element:AgentElement (asset:{path,type,name})} ] }
// Waktu dalam detik. Seluruh draf = satu langkah Undo.
type Match = { agentId?: string; id?: string };
type DraftOp =
	| { op: "set"; match: Match; start?: number; duration?: number; trimStart?: number; params?: Record<string, unknown> }
	| { op: "delete"; match: Match }
	| { op: "add"; track: { name: string; type?: "video" | "audio" | "effect"; index?: number }; element: AgentElement };
type Draft = { schema: string; rev: string; label?: string; projectId?: string; ops: DraftOp[] };

/** Ganti seluruh trek sekaligus; undo mengembalikan keadaan sebelum draf. */
class AgentDraftCommand extends Command {
	private saved: SceneTracks | null = null;
	constructor(private readonly next: SceneTracks) {
		super();
	}
	execute() {
		const editor = EditorCore.getInstance();
		this.saved = editor.scenes.getActiveScene().tracks;
		editor.timeline.updateTracks(this.next);
		return undefined;
	}
	undo() {
		if (this.saved) EditorCore.getInstance().timeline.updateTracks(this.saved);
	}
}

let applying = false;
async function pollDraft() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	if (!project || applying) return;
	if (editor.timeline.isPreviewActive()) return; // manusia sedang drag: tunda sampai dilepas
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

export async function applyDraft(draft: Draft) {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	if (!project || !editor.scenes.getActiveSceneOrNull()) return;
	const canvas = project.settings.canvasSize;
	const results: any[] = [];
	const touched: { trackId: string; elementId: string }[] = [];
	const keyframes: PendingKeyframe[] = [];

	// Aset untuk op add dimuat dulu (async); timeline baru diubah sekaligus sesudahnya.
	const loaded = new Map<number, LoadedMedia>();
	for (const [i, op] of draft.ops.entries()) {
		if (op.op !== "add" || !op.element.asset || typeof op.element.asset === "string") continue;
		try {
			loaded.set(i, await loadAgentAsset({ projectId: project.metadata.id, asset: op.element.asset }));
		} catch (error) {
			results[i] = { op: "add", name: op.element.name, ok: false, error: String(error) };
		}
	}

	const current = editor.scenes.getActiveScene().tracks;
	const copy = (track: any) => ({ ...track, elements: [...track.elements] });
	const next: SceneTracks = { main: copy(current.main), overlay: current.overlay.map(copy), audio: current.audio.map(copy) };
	const allTracks = () => [...next.overlay, next.main, ...next.audio] as any[];
	const find = (m: Match) => {
		for (const track of allTracks()) {
			const index = track.elements.findIndex((el: any) => (m.id && el.id === m.id) || (m.agentId && el.agentId === m.agentId));
			if (index >= 0) return { track, index };
		}
		return null;
	};

	for (const [i, op] of draft.ops.entries()) {
		if (results[i]) continue;
		if (op.op === "add") {
			const type = op.track.type ?? (loaded.get(i)?.type === "audio" ? "audio" : op.element.effect ? "effect" : "video");
			let track: any = allTracks().find((t) => t.name === op.track.name && t.type === type);
			if (!track) {
				track = type === "audio"
					? { id: generateUUID(), name: op.track.name, type, muted: false, elements: [] }
					: type === "effect"
						? { id: generateUUID(), name: op.track.name, type, hidden: false, elements: [] }
						: { id: generateUUID(), name: op.track.name, type, muted: true, hidden: false, elements: [] };
				if (type === "audio") next.audio.push(track);
				else next.overlay.splice(Math.max(0, Math.min(op.track.index ?? 0, next.overlay.length)), 0, track);
			}
			try {
				const el = buildAgentElement({ e: op.element, media: loaded.get(i), trackId: track.id, canvas, keyframes });
				track.elements.push(el);
				touched.push({ trackId: track.id, elementId: el.id });
				results[i] = { op: "add", agentId: op.element.agent_id, track: track.name, ok: true };
			} catch (error) {
				results[i] = { op: "add", name: op.element.name, ok: false, error: String(error) };
			}
			continue;
		}
		const hit = find(op.match);
		if (!hit) {
			results[i] = { op: op.op, match: op.match, ok: false, error: "item tidak ditemukan (mungkin sudah dihapus di editor)" };
			continue;
		}
		const el = hit.track.elements[hit.index];
		if (op.op === "delete") {
			hit.track.elements.splice(hit.index, 1);
			results[i] = { op: "delete", match: op.match, ok: true };
			continue;
		}
		const patch: any = {};
		if (op.start !== undefined) patch.startTime = secs(op.start);
		if (op.duration !== undefined) patch.duration = secs(op.duration);
		if (op.trimStart !== undefined) patch.trimStart = secs(op.trimStart);
		if (el.sourceDuration !== undefined && (patch.duration !== undefined || patch.trimStart !== undefined)) {
			patch.trimEnd = Math.max(0, el.sourceDuration - (patch.trimStart ?? el.trimStart) - (patch.duration ?? el.duration));
		}
		if (op.params) patch.params = { ...el.params, ...op.params };
		hit.track.elements[hit.index] = { ...el, ...patch };
		touched.push({ trackId: hit.track.id, elementId: el.id });
		results[i] = { op: "set", match: op.match, ok: true };
	}

	const commands: Command[] = [new AgentDraftCommand(next)];
	for (const k of keyframes) {
		commands.push(new UpsertKeyframeCommand({ trackId: k.trackId, elementId: k.elementId, propertyPath: k.propertyPath, time: secs(k.time), value: k.value, interpolation: "linear" }));
	}
	editor.command.execute({ command: commands.length === 1 ? commands[0] : new BatchCommand(commands) });
	// Item yang barusan diubah/ditambah agen langsung terpilih, supaya terlihat di timeline.
	if (touched.length) editor.selection.setSelectedElements({ elements: touched });

	const failed = results.filter((r) => !r?.ok).length;
	toast(`Draf agen diterapkan: ${draft.label ?? draft.rev}`, {
		description: `${results.length - failed} perubahan${failed ? `, ${failed} dilewati` : ""} · item yang diubah terpilih · Ctrl+Z untuk membatalkan`,
	});
	fetch("/api/agent/applied", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ rev: draft.rev, label: draft.label, appliedAt: new Date().toISOString(), projectId: project.metadata.id, results }),
	}).catch(() => {});
}
