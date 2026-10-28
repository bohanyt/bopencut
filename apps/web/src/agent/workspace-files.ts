import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function writeAtomic(file: string, text: string) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, text);
		await fs.rename(temporary, file);
	} finally { await fs.rm(temporary, { force: true }); }
}

export async function readJson<T>(file: string): Promise<T | null> {
	try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

/** Realpath checks also prevent symlinks/junctions from escaping either configured root. */
export async function resolveAgentFile(value: string, workspace: string, filesRoot: string): Promise<string> {
	const roots = [...new Set([workspace, filesRoot])];
	const candidates = path.isAbsolute(value) ? [value] : roots.map((root) => path.resolve(root, value));
	for (const candidate of candidates) {
		for (const root of roots) {
			const relative = path.relative(root, candidate);
			if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) continue;
			try {
				const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
				const realRelative = path.relative(realRoot, realFile);
				if (!realRelative || realRelative === ".." || realRelative.startsWith(".." + path.sep) || path.isAbsolute(realRelative)) continue;
				if ((await fs.stat(realFile)).isFile()) return realFile;
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
	}
	throw new Error("File is missing or outside the configured agent roots");
}
