import { promises as fs } from "node:fs";
import path from "node:path";
import {
	atomicWrite,
	dataRoot,
	mediaResponse,
	projectDir,
	readJson,
	removeMedia,
	revision,
	safeId,
	saveMedia,
	withProjectLock,
} from "@/services/storage/server/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function allowed(req: Request): boolean {
	const url = new URL(req.url);
	const origin = req.headers.get("origin");
	return (
		(url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
		(!origin || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))
	);
}
const marker = (id: string) =>
	path.join(dataRoot(), "migrated", `${safeId(id)}.json`);
const projectFile = (id: string) => path.join(projectDir(id), "project.json");
async function names(dir: string): Promise<string[]> {
	try {
		return await fs.readdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}
async function handle(
	req: Request,
	{ params }: { params: Promise<{ slug: string[] }> },
): Promise<Response> {
	if (!allowed(req))
		return Response.json({ error: "Origin ditolak" }, { status: 403 });
	try {
		const s = (await params).slug;
		const method = req.method;
		if (s[0] === "sounds" && s.length === 1) {
			const file = path.join(dataRoot(), "sounds.json");
			if (method === "GET") return Response.json(await readJson(file));
			if (method === "PUT")
				return await withProjectLock("__sounds", async () => {
					const markerFile = path.join(dataRoot(), "sounds-migrated.json");
					const migrating = req.headers.get("if-none-match") === "*";
					if (
						migrating &&
						((await readJson(file)) || (await readJson(markerFile)))
					)
						return Response.json({ skipped: true });
					await atomicWrite(file, JSON.stringify(await req.json()));
					if (migrating)
						await atomicWrite(markerFile, JSON.stringify({ migrated: true }));
					return Response.json({ skipped: false });
				});
			if (method === "DELETE")
				return await withProjectLock("__sounds", async () => {
					await atomicWrite(
						path.join(dataRoot(), "sounds-migrated.json"),
						JSON.stringify({ deleted: true }),
					);
					await fs.rm(file, { force: true });
					return Response.json({ ok: true });
				});
		}
		if (s[0] === "projects" && s.length === 1 && method === "GET") {
			const projects = await Promise.all(
				(await names(path.join(dataRoot(), "projects")))
					.filter((id) => /^[a-zA-Z0-9_-]{1,128}$/.test(id))
					.map((id) => readJson(projectFile(id))),
			);
			return Response.json(projects.filter(Boolean));
		}
		if (s[0] === "projects" && s[1]) {
			const id = safeId(s[1]);
			if (s.length === 2 && method === "GET") {
				const project = await readJson(projectFile(id));
				return project
					? Response.json(project, { headers: { ETag: revision(project) } })
					: new Response(null, { status: 404 });
			}
			if (s.length === 2 && method === "PUT")
				return await withProjectLock(id, async () => {
					const value = await req.json();
					if (value?.metadata?.id !== id)
						return Response.json(
							{ error: "Project ID mismatch" },
							{ status: 400 },
						);
					const current = await readJson(projectFile(id));
					const migrating = req.headers.get("x-migration") === "1";
					if (migrating && (current || (await readJson(marker(id)))))
						return Response.json({ skipped: true });
					const expected = req.headers.get("if-match");
					if (!migrating && expected !== (current ? revision(current) : "new"))
						return Response.json({ error: "Project changed" }, { status: 409 });
					await atomicWrite(projectFile(id), JSON.stringify(value));
					if (migrating)
						await atomicWrite(marker(id), JSON.stringify({ migrated: true }));
					return Response.json(
						{ skipped: false },
						{ headers: { ETag: revision(value) } },
					);
				});
			if (s.length === 2 && method === "DELETE")
				return await withProjectLock(id, async () => {
					await atomicWrite(marker(id), JSON.stringify({ deleted: true }));
					await fs.rm(projectDir(id), { recursive: true, force: true });
					return Response.json({ ok: true });
				});
			if (s[2] === "migration" && s.length === 3 && method === "GET")
				return Response.json({
					exists:
						!!(await readJson(projectFile(id))) ||
						!!(await readJson(marker(id))),
				});
			if (s[2] === "media" && s.length === 3 && method === "GET") {
				const dir = path.join(projectDir(id), "media", "_metadata");
				return Response.json(
					(
						await Promise.all(
							(await names(dir))
								.filter((n) => /^[a-zA-Z0-9_-]{1,128}\.json$/.test(n))
								.map((n) => readJson(path.join(dir, n))),
						)
					).filter(
						(meta) =>
							meta &&
							typeof meta.name === "string" &&
							typeof meta.type === "string",
					),
				);
			}
			if (s[2] === "media" && s.length === 3 && method === "DELETE")
				return await withProjectLock(id, async () => {
					await fs.rm(path.join(projectDir(id), "media"), {
						recursive: true,
						force: true,
					});
					return Response.json({ ok: true });
				});
			if (s[2] === "media" && s[3] && s.length === 4) {
				const mediaId = safeId(s[3]);
				if (method === "GET")
					return await mediaResponse(id, mediaId, req.headers.get("range"));
				if (method === "PUT")
					return await withProjectLock(id, async () => {
						if (!req.body) return new Response(null, { status: 400 });
						const metadata = JSON.parse(
							decodeURIComponent(req.headers.get("x-media-metadata") ?? ""),
						);
						await saveMedia(id, mediaId, metadata, req.body);
						return Response.json({ ok: true });
					});
				if (method === "POST")
					return await withProjectLock(id, async () => {
						const dir = path.join(projectDir(id), "media", "_metadata");
						const file = path.join(dir, `${mediaId}.json`);
						const old = await readJson(file);
						const metadata = await req.json();
						if (!old || metadata.id !== mediaId)
							return new Response(null, { status: 400 });
						await atomicWrite(
							file,
							JSON.stringify({ ...metadata, diskFile: old.diskFile }),
						);
						return Response.json({ ok: true });
					});
				if (method === "DELETE")
					return await withProjectLock(id, async () => {
						await removeMedia(id, mediaId);
						return Response.json({ ok: true });
					});
			}
		}
		return new Response(null, { status: 404 });
	} catch (error) {
		console.error("Storage:", error);
		return Response.json({ error: String(error) }, { status: 400 });
	}
}
export const GET = handle;
export const PUT = handle;
export const DELETE = handle;

export const POST = handle;
