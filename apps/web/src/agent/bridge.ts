// Setiap perubahan timeline ditulis ke AGENT_WORKSPACE/project.json (detik, piksel),
// supaya agen tahu lokasi/waktu/posisi tiap item tanpa membuka browser.
import { EditorCore } from "@/core";
import { TICKS_PER_SECOND, mediaTimeFromSeconds } from "@/wasm";
import { toast } from "sonner";
import { BatchCommand } from "@/commands";
import { UpdateElementsCommand, DeleteElementsCommand } from "@/commands/timeline";

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

// Draf agen = daftar operasi per item (bukan proyek utuh), supaya edit owner tidak tertimpa.
// { schema:"opencut-agent-draft-1", rev, label, projectId?, ops:[
//   {op:"set", match:{agentId}|{id}, start?, duration?, trimStart?, params?},
//   {op:"delete", match:{agentId}|{id}} ] }   waktu dalam detik.
type DraftOp = { op: "set" | "delete"; match: { agentId?: string; id?: string }; start?: number; duration?: number; trimStart?: number; params?: Record<string, unknown> };
type Draft = { schema: string; rev: string; label?: string; projectId?: string; ops: DraftOp[] };

async function pollDraft() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	if (!project) return;
	let draft: Draft | null = null;
	try { draft = await (await fetch("/api/agent/draft", { cache: "no-store" })).json(); } catch { return; }
	if (!draft?.rev || (draft.projectId && draft.projectId !== project.metadata.id)) return;
	const key = `agent-draft-${project.metadata.id}`;
	if (localStorage.getItem(key) === draft.rev) return;
	localStorage.setItem(key, draft.rev);
	applyDraft(draft);
}

export function applyDraft(draft: Draft) {
	const editor = EditorCore.getInstance();
	const scene = editor.scenes.getActiveSceneOrNull();
	if (!scene) return;
	const t = scene.tracks;
	const all = [...t.overlay, t.main, ...t.audio].flatMap((track: any) => track.elements.map((el: any) => ({ trackId: track.id, el })));
	const find = (m: DraftOp["match"]) => all.find(({ el }) => (m.id && el.id === m.id) || (m.agentId && el.agentId === m.agentId));
	const updates: any[] = [], deletes: { trackId: string; elementId: string }[] = [], results: any[] = [];
	for (const op of draft.ops) {
		const hit = find(op.match);
		if (!hit) { results.push({ match: op.match, ok: false, error: "item tidak ditemukan (mungkin sudah dihapus di editor)" }); continue; }
		const { el, trackId } = hit;
		if (op.op === "delete") { deletes.push({ trackId, elementId: el.id }); results.push({ match: op.match, ok: true }); continue; }
		const patch: any = {};
		if (op.start !== undefined) patch.startTime = mediaTimeFromSeconds({ seconds: op.start });
		if (op.duration !== undefined) patch.duration = mediaTimeFromSeconds({ seconds: op.duration });
		if (op.trimStart !== undefined) patch.trimStart = mediaTimeFromSeconds({ seconds: op.trimStart });
		if (el.sourceDuration !== undefined && (patch.duration !== undefined || patch.trimStart !== undefined)) {
			const src = el.sourceDuration, ts = patch.trimStart ?? el.trimStart, d = patch.duration ?? el.duration;
			patch.trimEnd = Math.max(0, src - ts - d);
		}
		if (op.params) patch.params = { ...el.params, ...op.params };
		updates.push({ trackId, elementId: el.id, patch });
		results.push({ match: op.match, ok: true });
	}
	// Satu draf = satu langkah Undo.
	const commands: any[] = [];
	if (updates.length) commands.push(new UpdateElementsCommand({ updates }));
	if (deletes.length) commands.push(new DeleteElementsCommand({ elements: deletes }));
	if (commands.length) editor.command.execute({ command: commands.length === 1 ? commands[0] : new BatchCommand(commands) });
	const failed = results.filter((r) => !r.ok).length;
	toast(`Draf agen diterapkan: ${draft.label ?? draft.rev}`, { description: `${results.length - failed} perubahan${failed ? `, ${failed} dilewati` : ""} · Ctrl+Z untuk membatalkan` });
	fetch("/api/agent/applied", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rev: draft.rev, label: draft.label, appliedAt: new Date().toISOString(), projectId: editor.project.getActiveOrNull()?.metadata.id, results }) }).catch(() => {});
}
