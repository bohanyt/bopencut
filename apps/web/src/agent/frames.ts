import { EditorCore } from "@/core";
import { calculateTotalDuration } from "@/timeline";
import { lastFrameMediaTime, mediaTimeFromSeconds } from "@/wasm";
import { getRootScene } from "./scene-graph";
import { expectsDifferentTimeline, frameRevision, type FrameRequest } from "./frame-protocol";

let busy = false;
export function currentFrameRevision(): { snapshotHash?: string; rev?: string } {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const root = getRootScene(editor.scenes.getScenes(), editor.scenes.getActiveSceneOrNull()?.id ?? null);
	return project && root ? frameRevision(editor.scenes.getScenes(), root.id, project.settings) : {};
}

async function post(endpoint: string, body: unknown) {
	const response = await fetch(`/api/agent/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

/** Check before and after every asynchronous render, so versions never mix. */
export async function runFrameRequest(request: FrameRequest, token: string) {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	const initialHash = currentFrameRevision().snapshotHash;
	const update = (patch: Record<string, unknown>) => post("frames-status", { id: request.id, token, ...patch });
	const changed = () => editor.project.getActiveOrNull()?.metadata.id !== request.projectId || currentFrameRevision().snapshotHash !== initialHash;
	if (!project || project.metadata.id !== request.projectId || !initialHash || expectsDifferentTimeline(request, initialHash)) {
		await update({ status: "stale", error: "Requested timeline no longer matches the editor" });
		return;
	}
	await update({ snapshotHash: initialHash });
	let errors = 0;
	for (const [index, time] of request.times.entries()) {
		if (changed()) { await update({ status: "stale", error: "Timeline changed during capture" }); return; }
		try {
			if (editor.timeline.isPreviewActive()) throw new Error("Timeline drag is in progress; retry with a new request ID");
			const root = getRootScene(editor.scenes.getScenes(), editor.scenes.getActiveSceneOrNull()?.id ?? null);
			if (!root) throw new Error("No scene");
			const ticks = mediaTimeFromSeconds({ seconds: time });
			const duration = calculateTotalDuration({ tracks: root.tracks });
			if (ticks > lastFrameMediaTime({ duration, fps: project.settings.fps })) throw new Error(`Time outside timeline: ${time}`);
			const snapshot = await editor.renderer.createSnapshot({ time: ticks, sceneId: root.id });
			if (!snapshot.success) throw new Error(snapshot.error);
			const image = await createImageBitmap(snapshot.blob);
			const canvas = document.createElement("canvas");
			canvas.width = request.width ?? 960;
			canvas.height = Math.max(1, Math.round(canvas.width * image.height / image.width));
			try {
				const context = canvas.getContext("2d");
				if (!context) throw new Error("Canvas unavailable");
				context.drawImage(image, 0, 0, canvas.width, canvas.height);
			} finally { image.close(); }
			const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
			if (!blob) throw new Error("Failed to create JPEG");
			if (changed()) { await update({ status: "stale", error: "Timeline changed during capture" }); return; }
			const form = new FormData();
			form.set("id", request.id); form.set("token", token); form.set("index", String(index)); form.set("image", blob);
			const response = await fetch("/api/agent/frame", { method: "POST", body: form });
			if (!response.ok) throw new Error(await response.text());
		} catch (error) {
			if (changed()) { await update({ status: "stale", error: "Timeline changed during capture" }); return; }
			errors++;
			await update({ index, error: error instanceof Error ? error.message : String(error) });
		}
	}
	await update(changed() ? { status: "stale", error: "Timeline changed during capture" } : { status: errors ? "error" : "done" });
}

export async function pollFrames() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	if (!project || busy || editor.timeline.isPreviewActive()) return;
	busy = true;
	try {
		const response = await fetch(`/api/agent/frames-request?projectId=${encodeURIComponent(project.metadata.id)}`, { cache: "no-store" });
		if (!response.ok) throw new Error(await response.text());
		const request: FrameRequest | null = await response.json();
		if (!request || request.projectId !== project.metadata.id) return;
		const claim = await post("frames-claim", { id: request.id, projectId: project.metadata.id });
		if (claim.token) await runFrameRequest(request, claim.token);
	} catch (error) { console.error("Agent frame failed:", error); }
	finally { busy = false; }
}
