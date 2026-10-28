import { EditorCore } from "@/core";
import { calculateTotalDuration } from "@/timeline";
import { lastFrameMediaTime, mediaTimeFromSeconds } from "@/wasm";
import { getRootScene } from "./scene-graph";

let busy = false;
export async function pollFrames() {
	const editor = EditorCore.getInstance();
	const project = editor.project.getActiveOrNull();
	if (!project || busy || editor.timeline.isPreviewActive()) return;
	busy = true;
	try {
		const request = await (await fetch("/api/agent/frames-request", { cache: "no-store" })).json();
		if (!request || typeof request.rev !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(request.rev) || !Array.isArray(request.times) || !request.times.length || request.times.some((t: unknown) => typeof t !== "number" || !Number.isFinite(t) || t < 0) || (request.width !== undefined && (!Number.isInteger(request.width) || request.width < 1 || request.width > 4096))) return;
		const key = `agent-frames-${project.metadata.id}`;
		if (localStorage.getItem(key) === request.rev) return;
		const files: string[] = [];
		for (const time of request.times as number[]) {
			if (editor.timeline.isPreviewActive() || editor.project.getActiveOrNull()?.metadata.id !== project.metadata.id) return;
			// Frames show the root timeline (compound clips rendered with their content), also while the human is inside a compound.
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
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Canvas unavailable");
			context.drawImage(image, 0, 0, canvas.width, canvas.height);
			image.close();
			const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
			if (!blob) throw new Error("Failed to create JPEG");
			const form = new FormData();
			form.set("rev", request.rev); form.set("time", String(time)); form.set("image", blob);
			const response = await fetch("/api/agent/frame", { method: "POST", body: form });
			if (!response.ok) throw new Error(await response.text());
			files.push((await response.json()).file);
		}
		const response = await fetch("/api/agent/frames-result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rev: request.rev, files, projectId: project.metadata.id }) });
		if (!response.ok) throw new Error(await response.text());
		localStorage.setItem(key, request.rev);
	} catch (error) { console.error("Agent frame failed:", error); }
	finally { busy = false; }
}
