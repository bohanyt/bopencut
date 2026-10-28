import path from "node:path";
import { promises as fs, createReadStream, createWriteStream } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export function safeId(id: string): string {
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid ID");
	return id;
}

export function dataRoot(): string {
	return path.resolve(
		process.env.BOPENCUT_DATA ??
			path.join(process.cwd(), "..", "..", "workspace"),
	);
}

export function projectDir(id: string): string {
	return path.join(dataRoot(), "projects", safeId(id));
}

// Windows refuses to replace or open a file that another handle (a reader, an indexer, a virus
// scanner) holds for a moment: EPERM/EACCES/EBUSY. Those clear within milliseconds, so retry.
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"]);
export const isTransientFsError = (error: unknown) =>
	TRANSIENT.has((error as NodeJS.ErrnoException)?.code ?? "");

/** Runs `action`, retrying transient file-lock errors with exponential backoff (about 2.5 s in total). */
export async function retryTransient<T>(
	action: () => Promise<T>,
	{
		attempts = 9,
		delayMs = 10,
		sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
	}: {
		attempts?: number;
		delayMs?: number;
		sleep?: (ms: number) => Promise<void>;
	} = {},
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await action();
		} catch (error) {
			if (attempt >= attempts || !isTransientFsError(error)) throw error;
			await sleep(delayMs * 2 ** (attempt - 1));
		}
	}
}

export const renameWithRetry = (from: string, to: string) =>
	retryTransient(() => fs.rename(from, to));

// Writes to one file run one after another (two renames onto the same target race on Windows).
const fileQueues = new Map<string, Promise<void>>();
export async function atomicWrite(file: string, data: string): Promise<void> {
	const key = path.resolve(file).toLowerCase();
	const previous = fileQueues.get(key) ?? Promise.resolve();
	const current = previous.catch(() => undefined).then(async () => {
		await fs.mkdir(path.dirname(file), { recursive: true });
		const temp = `${file}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temp, data);
			await renameWithRetry(temp, file);
		} finally {
			await fs.rm(temp, { force: true });
		}
	});
	fileQueues.set(key, current);
	try {
		await current;
	} finally {
		if (fileQueues.get(key) === current) fileQueues.delete(key);
	}
}

export async function readJson(file: string): Promise<any | null> {
	try {
		return JSON.parse(await retryTransient(() => fs.readFile(file, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function revision(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// One queue per project keeps revision checks and renames ordered.
const locks = new Map<string, Promise<void>>();
export async function withProjectLock<T>(
	id: string,
	action: () => Promise<T>,
): Promise<T> {
	const previous = locks.get(id) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	locks.set(id, current);
	await previous;
	try {
		return await action();
	} finally {
		release();
		if (locks.get(id) === current) locks.delete(id);
	}
}

export async function saveMedia(
	id: string,
	mediaId: string,
	metadata: any,
	body: ReadableStream<Uint8Array>,
): Promise<void> {
	const dir = path.join(projectDir(id), "media");
	safeId(mediaId);
	if (
		metadata.id !== mediaId ||
		typeof metadata.fileName !== "string" ||
		typeof metadata.fileType !== "string"
	)
		throw new Error("Invalid metadata");
	await fs.mkdir(dir, { recursive: true });
	const ext = path.extname(metadata.fileName).toLowerCase();
	const suffix = /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : ".bin";
	const fileName = `${mediaId}${suffix}`;
	const file = path.join(dir, fileName);
	const metaFile = path.join(dir, "_metadata", `${mediaId}.json`);
	const old = await readJson(metaFile);
	if (old) return;
	const temp = path.join(dir, `${mediaId}.${randomUUID()}.tmp`);
	try {
		await pipeline(
			Readable.fromWeb(
				body as unknown as import("node:stream/web").ReadableStream,
			),
			createWriteStream(temp, { flags: "wx" }),
		);
		await renameWithRetry(temp, file);
		try {
			await atomicWrite(
				metaFile,
				JSON.stringify({ ...metadata, diskFile: fileName }),
			);
		} catch (error) {
			// Without metadata the file is unreachable: do not leave it behind.
			await fs.rm(file, { force: true });
			throw error;
		}
	} finally {
		await fs.rm(temp, { force: true });
	}
}

export async function mediaResponse(
	id: string,
	mediaId: string,
	range: string | null,
): Promise<Response> {
	const dir = path.join(projectDir(id), "media");
	const meta = await readJson(
		path.join(dir, "_metadata", `${safeId(mediaId)}.json`),
	);
	if (!meta || !new RegExp(`^${mediaId}\\.[a-z0-9]{1,10}$`).test(meta.diskFile))
		return new Response(null, { status: 404 });
	const file = path.join(dir, meta.diskFile);
	const stat = await fs.stat(file);
	let start = 0,
		end = stat.size - 1,
		status = 200;
	const headers: Record<string, string> = {
		"Accept-Ranges": "bytes",
		"Content-Type": meta.fileType || "application/octet-stream",
		"Cache-Control": "no-store",
	};
	if (range) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(range);
		if (!match || (!match[1] && !match[2]) || !stat.size)
			return new Response(null, {
				status: 416,
				headers: { "Content-Range": `bytes */${stat.size}` },
			});
		if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
		else {
			start = Number(match[1]);
			if (match[2]) end = Math.min(end, Number(match[2]));
		}
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start > end ||
			start >= stat.size
		)
			return new Response(null, {
				status: 416,
				headers: { "Content-Range": `bytes */${stat.size}` },
			});
		status = 206;
		headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
	}
	headers["Content-Length"] = String(stat.size ? end - start + 1 : 0);
	if (!stat.size) return new Response(null, { status, headers });
	return new Response(
		Readable.toWeb(
			createReadStream(file, { start, end }),
		) as unknown as ReadableStream,
		{ status, headers },
	);
}

/**
 * Deletes a media file and its metadata. Also removes a file whose metadata write failed
 * (`<mediaId>.<ext>` without metadata), so a failed import leaves nothing behind.
 */
export async function removeMedia(id: string, mediaId: string): Promise<void> {
	const dir = path.join(projectDir(id), "media");
	safeId(mediaId);
	const metaFile = path.join(dir, "_metadata", `${mediaId}.json`);
	const meta = await readJson(metaFile);
	const own = new RegExp(`^${mediaId}\\.[a-z0-9]{1,10}$`);
	const files = meta && own.test(meta.diskFile)
		? [meta.diskFile as string]
		: (await fs.readdir(dir).catch(() => [] as string[])).filter((name) => own.test(name));
	for (const name of files) await retryTransient(() => fs.rm(path.join(dir, name), { force: true }));
	await retryTransient(() => fs.rm(metaFile, { force: true }));
}
