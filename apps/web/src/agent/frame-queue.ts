import { promises as fs } from "node:fs";
import path from "node:path";
import { RequestQueue } from "./request-queue";
import { readJson } from "./workspace-files";
import { type FrameRequest, validateFrameRequest, requestIdPattern } from "./frame-protocol";

export async function discoverFrames(workspace: string) {
	const queue = new RequestQueue(workspace, "frames");
	for (const { id, file } of await queue.entries()) {
		if (await queue.state(id)) continue;
		try {
			const request = validateFrameRequest(await readJson(file), id);
			await queue.initialize({ id, projectId: request.projectId, status: "queued", done: 0, total: request.times.length, files: [], errors: [], request });
		} catch (error) { await queue.initialize({ id, status: "error", done: 0, total: 0, files: [], errors: [], error: String(error) }); }
	}
	// Legacy IDs remain revs. Capture their target once from the last sync at discovery.
	const legacy = await readJson<Record<string, unknown>>(path.join(workspace, "frames-request.json")).catch(() => null);
	if (legacy && typeof legacy.rev === "string" && requestIdPattern.test(legacy.rev) && !await queue.state(legacy.rev)) {
		const sync = await readJson<{ projectId?: string }>(path.join(workspace, "project.json"));
		const projectId = legacy.projectId ?? sync?.projectId;
		if (projectId) {
			try {
				const request = { ...validateFrameRequest({ ...legacy, projectId }, legacy.rev), legacy: true };
				await queue.initialize({ id: request.id, projectId: request.projectId, rev: legacy.rev, status: "queued", done: 0, total: request.times.length, files: [], errors: [], request });
			} catch (error) { await queue.initialize({ id: legacy.rev, status: "error", done: 0, total: 0, files: [], errors: [], error: String(error) }); }
		}
	}
	return queue;
}

export async function nextFrameRequest(workspace: string, projectId: string): Promise<FrameRequest | null> {
	const queue = await discoverFrames(workspace);
	const entries = await queue.entries();
	const legacy = await readJson<{ rev?: string }>(path.join(workspace, "frames-request.json")).catch(() => null);
	if (legacy?.rev && requestIdPattern.test(legacy.rev) && !entries.some((e) => e.id === legacy.rev)) entries.push({ id: legacy.rev, file: "", time: 0 });
	for (const { id } of entries) {
		const state = await queue.state(id);
		if (state?.projectId !== projectId) continue;
		if (state.status === "running") return null;
		if (state.status === "queued") return state.request as FrameRequest;
	}
	return null;
}

export async function writeQueuedFrame(workspace: string, form: FormData) {
	const id = String(form.get("id") ?? "");
	const queue = new RequestQueue(workspace, "frames");
	if (!await queue.owns(id, form.get("token"))) throw new Error("Frame request is not owned by this worker");
	const state = (await queue.state(id))!;
	const request = state.request as FrameRequest;
	const index = Number(form.get("index"));
	const image = form.get("image");
	if (!Number.isInteger(index) || index !== state.done || index >= request.times.length || !(image instanceof File) || image.type !== "image/jpeg") throw new Error("Invalid frame index or JPEG");
	const file = `frames/${id}/${request.legacy ? request.times[index] : index}.jpg`;
	await fs.writeFile(path.join(workspace, file), Buffer.from(await image.arrayBuffer()));
	await queue.update(id, form.get("token"), { done: index + 1, files: [...state.files as string[], file] });
	return file;
}
