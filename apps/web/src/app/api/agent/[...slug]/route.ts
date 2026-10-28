// Local OpenCut <-> agent bridge (AI/scripts). For local development only (127.0.0.1).
//
// AGENT_WORKSPACE   agent workspace: bundle/bundle.json, sync/<projectId>.json,
//                   project.json (last synced project), draft.json, draft-result.json
// AGENT_FILES_ROOT  bundle asset root (default = AGENT_WORKSPACE). Files outside this root are not served.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeAtomic, resolveAgentFile } from "@/agent/workspace-files";
import { readAgentBundle } from "@/agent/bundle-files";
import { nextFrameRequest, writeQueuedFrame } from "@/agent/frame-queue";
import { nextImportRequest } from "@/agent/import-queue";
import { RequestQueue } from "@/agent/request-queue";
import type { FrameRequest } from "@/agent/frame-protocol";

const run = promisify(execFile);
const WORKSPACE = path.resolve(process.env.AGENT_WORKSPACE ?? path.join(process.cwd(), "..", "..", "workspace"));
const FILES_ROOT = path.resolve(process.env.AGENT_FILES_ROOT ?? WORKSPACE);
const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".json": "application/json" };
const json = (data: Buffer | string) => new Response(typeof data === "string" ? data : new Uint8Array(data), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function GET(req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
	const { slug } = await params;
	try {
		if (slug[0] === "bundle") {
			const result = await readAgentBundle(new URL(req.url).searchParams.get("bundlePath") ?? "bundle/bundle.json", WORKSPACE, FILES_ROOT);
			return Response.json(result.ok ? result.bundle : result, { status: result.ok ? 200 : 400 });
		}
		if (slug[0] === "file") {
			const full = await resolveAgentFile(new URL(req.url).searchParams.get("p") ?? "", FILES_ROOT, WORKSPACE);
			return new Response(new Uint8Array(await fs.readFile(full)), { headers: { "Content-Type": TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store" } });
		}
		if (slug[0] === "frames-request") {
			return Response.json(await nextFrameRequest(WORKSPACE, new URL(req.url).searchParams.get("projectId") ?? ""));
		}
		if (slug[0] === "imports-request") return Response.json(await nextImportRequest(WORKSPACE));
		if (slug[0] === "frames-status" || slug[0] === "imports-result") {
			const queue = new RequestQueue(WORKSPACE, slug[0] === "frames-status" ? "frames" : "imports");
			return Response.json(await queue.state(new URL(req.url).searchParams.get("id") ?? ""));
		}
		if (slug[0] === "draft") {
			try { return json(await fs.readFile(path.join(WORKSPACE, "draft.json"))); } catch { return Response.json(null); }
		}
	} catch (error) {
		return Response.json({ error: String(error) }, { status: 404 });
	}
	return Response.json({ error: "Not found" }, { status: 404 });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
	const { slug } = await params;
	const origin = req.headers.get("origin");
	if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return Response.json({ error: "Origin rejected" }, { status: 403 });
	try {
	if (slug[0] === "frames-claim" || slug[0] === "imports-claim") {
		const body = await req.json();
		const frames = slug[0] === "frames-claim";
		const next = frames ? await nextFrameRequest(WORKSPACE, body.projectId) : await nextImportRequest(WORKSPACE);
		const token = next?.id === body.id ? await new RequestQueue(WORKSPACE, frames ? "frames" : "imports").claim(body.id, body.projectId) : null;
		return Response.json({ token });
	}
	if (slug[0] === "imports-result") {
		const { id, token, status, projectId, assets, error } = await req.json();
		if (!["done", "error"].includes(status) || !Array.isArray(assets) || (status === "done" && typeof projectId !== "string")) throw new Error("Invalid import result");
		await new RequestQueue(WORKSPACE, "imports").update(id, token, { status, projectId, assets, error });
		return Response.json({ ok: true });
	}
	if (slug[0] === "frames-status") {
		const { id, token, status, index, error, snapshotHash } = await req.json();
		const queue = new RequestQueue(WORKSPACE, "frames");
		const state = await queue.state(id);
		if (!state) throw new Error("Frame request not found");
		const request = state.request as FrameRequest;
		const patch: Record<string, unknown> = {};
		if (snapshotHash !== undefined) patch.snapshotHash = snapshotHash;
		if (index !== undefined) {
			if (index !== state.done || !Number.isInteger(index) || index >= request.times.length || typeof error !== "string") throw new Error("Invalid frame error");
			patch.done = index + 1;
			patch.errors = [...state.errors as unknown[], { index, time: request.times[index], error }];
		}
		if (status !== undefined) {
			if (!["done", "error", "stale"].includes(status) || (status === "done" && state.done !== state.total)) throw new Error("Invalid terminal frame status");
			patch.status = status;
			if (error) patch.error = error;
		}
		await queue.update(id, token, patch);
		if (status && request.legacy) await writeAtomic(path.join(WORKSPACE, "frames-result.json"), JSON.stringify(await queue.state(id), null, 1));
		return Response.json({ ok: true });
	}
	if (slug[0] === "frame") {
		const form = await req.formData();
		if (form.has("id")) return Response.json({ file: await writeQueuedFrame(WORKSPACE, form) });
		const rev = form.get("rev"); const time = form.get("time"); const image = form.get("image");
		if (typeof rev !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(rev) || typeof time !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(time) || !(image instanceof File) || image.type !== "image/jpeg") return Response.json({ error: "Invalid frame" }, { status: 400 });
		const file = `frames/${rev}/${time}.jpg`;
		await fs.mkdir(path.join(WORKSPACE, "frames", rev), { recursive: true });
		await fs.writeFile(path.join(WORKSPACE, "frames", rev, `${time}.jpg`), Buffer.from(await image.arrayBuffer()));
		return Response.json({ file });
	}
	if (slug[0] === "frames-result") {
		await writeAtomic(path.join(WORKSPACE, "frames-result.json"), JSON.stringify(await req.json(), null, 1));
		return Response.json({ ok: true });
	}
	if (slug[0] === "sync") {
		const body = await req.json();
		const text = JSON.stringify(body, null, 1);
		const safe = String(body.projectId ?? "tanpa-id").replace(/[^a-zA-Z0-9-]/g, "");
		await writeAtomic(path.join(WORKSPACE, "sync", `${safe}.json`), text);
		await writeAtomic(path.join(WORKSPACE, "project.json"), text);
		return Response.json({ ok: true });
	}
	if (slug[0] === "edits") {
		const lines = await req.json();
		if (!Array.isArray(lines) || !lines.length || lines.some((line) => typeof line.projectId !== "string" || !/^[a-zA-Z0-9-]+$/.test(line.projectId) || line.projectId !== lines[0].projectId || line.actor !== "user")) return Response.json({ error: "Invalid log" }, { status: 400 });
		const dir = path.join(WORKSPACE, "edits");
		await fs.mkdir(dir, { recursive: true });
		await fs.appendFile(path.join(dir, `${lines[0].projectId}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
		return Response.json({ ok: true });
	}
	if (slug[0] === "applied") {
		await writeAtomic(path.join(WORKSPACE, "draft-result.json"), JSON.stringify(await req.json(), null, 1));
		return Response.json({ ok: true });
	}
	if (slug[0] === "gif") {
		// GIF -> silent MP4 (looped 3x) for timeline animation; OpenCut renders GIFs as still images.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-gif-"));
		try {
			await fs.writeFile(path.join(dir, "in.gif"), Buffer.from(await req.arrayBuffer()));
			await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "2", "-i", path.join(dir, "in.gif"), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart", path.join(dir, "out.mp4")]);
			return new Response(new Uint8Array(await fs.readFile(path.join(dir, "out.mp4"))), { headers: { "Content-Type": "video/mp4" } });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}
	return Response.json({ error: "Not found" }, { status: 404 });
	} catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
}
