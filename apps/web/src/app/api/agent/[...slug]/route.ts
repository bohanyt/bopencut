// Jembatan lokal OpenCut <-> agen (AI/skrip). Hanya untuk dev lokal (127.0.0.1).
//
// AGENT_WORKSPACE   folder kerja agen: bundle/bundle.json, sync/<projectId>.json,
//                   project.json (proyek terakhir yang disinkron), draft.json, draft-result.json
// AGENT_FILES_ROOT  akar path aset di bundle (default = AGENT_WORKSPACE). Tidak ada file di luar akar ini yang dilayani.
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const WORKSPACE = path.resolve(process.env.AGENT_WORKSPACE ?? path.join(process.cwd(), "..", "..", "workspace"));
const FILES_ROOT = path.resolve(process.env.AGENT_FILES_ROOT ?? WORKSPACE);
const TYPES: Record<string, string> = { ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".json": "application/json" };
const json = (data: Buffer | string) => new Response(typeof data === "string" ? data : new Uint8Array(data), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

function inside(rel: string) {
	const full = path.resolve(FILES_ROOT, rel);
	if (!full.startsWith(FILES_ROOT + path.sep)) throw new Error("Path di luar AGENT_FILES_ROOT");
	return full;
}

async function writeAtomic(file: string, text: string) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file + ".tmp", text);
	await fs.rename(file + ".tmp", file);
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
	const { slug } = await params;
	try {
		if (slug[0] === "bundle") return json(await fs.readFile(path.join(WORKSPACE, "bundle", "bundle.json")));
		if (slug[0] === "file") {
			const full = inside(new URL(req.url).searchParams.get("p") ?? "");
			return new Response(new Uint8Array(await fs.readFile(full)), { headers: { "Content-Type": TYPES[path.extname(full).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store" } });
		}
		if (slug[0] === "draft") {
			try { return json(await fs.readFile(path.join(WORKSPACE, "draft.json"))); } catch { return Response.json(null); }
		}
	} catch (error) {
		return Response.json({ error: String(error) }, { status: 404 });
	}
	return Response.json({ error: "Tidak ditemukan" }, { status: 404 });
}

export async function POST(req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
	const { slug } = await params;
	const origin = req.headers.get("origin");
	if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return Response.json({ error: "Origin ditolak" }, { status: 403 });
	if (slug[0] === "sync") {
		const body = await req.json();
		const text = JSON.stringify(body, null, 1);
		const safe = String(body.projectId ?? "tanpa-id").replace(/[^a-zA-Z0-9-]/g, "");
		await writeAtomic(path.join(WORKSPACE, "sync", `${safe}.json`), text);
		await writeAtomic(path.join(WORKSPACE, "project.json"), text);
		return Response.json({ ok: true });
	}
	if (slug[0] === "applied") {
		await writeAtomic(path.join(WORKSPACE, "draft-result.json"), JSON.stringify(await req.json(), null, 1));
		return Response.json({ ok: true });
	}
	if (slug[0] === "gif") {
		// GIF -> MP4 bisu (diputar 3x) supaya bergerak di timeline; OpenCut menggambar GIF sebagai gambar diam.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-gif-"));
		try {
			await fs.writeFile(path.join(dir, "in.gif"), Buffer.from(await req.arrayBuffer()));
			await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-stream_loop", "2", "-i", path.join(dir, "in.gif"), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-movflags", "+faststart", path.join(dir, "out.mp4")]);
			return new Response(new Uint8Array(await fs.readFile(path.join(dir, "out.mp4"))), { headers: { "Content-Type": "video/mp4" } });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	}
	return Response.json({ error: "Tidak ditemukan" }, { status: 404 });
}
