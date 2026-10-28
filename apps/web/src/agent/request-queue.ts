// Disk-backed claims coordinate independent browser tabs. Requests are immutable; retry with a new ID.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readJson, writeAtomic } from "./workspace-files";
import { requestIdPattern } from "./frame-protocol";

export type QueueState = { id: string; status: string; projectId?: string; updatedAt?: string; [key: string]: unknown };
export class RequestQueue {
	constructor(readonly workspace: string, readonly kind: "frames" | "imports") {}
	directory() { return path.join(this.workspace, this.kind, ...(this.kind === "frames" ? ["requests"] : [])); }
	resultPath(id: string) {
		if (!requestIdPattern.test(id)) throw new Error("Invalid request ID");
		return this.kind === "frames" ? path.join(this.workspace, "frames", id, "status.json") : path.join(this.directory(), `${id}.result.json`);
	}
	private claimPath(id: string) { this.resultPath(id); return path.join(this.directory(), `${id}.claim.json`); }
	async entries() {
		await fs.mkdir(this.directory(), { recursive: true });
		const entries = await Promise.all((await fs.readdir(this.directory())).filter((name) => /^[a-zA-Z0-9_-]{1,100}\.json$/.test(name)).map(async (name) => ({
			id: name.slice(0, -5), file: path.join(this.directory(), name), time: (await fs.stat(path.join(this.directory(), name))).mtimeMs,
		})));
		return entries.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
	}
	async state(id: string) { return readJson<QueueState>(this.resultPath(id)); }
	async write(state: QueueState) {
		await writeAtomic(this.resultPath(state.id), JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 1));
	}
	async initialize(state: QueueState) {
		const file = this.resultPath(state.id);
		await fs.mkdir(path.dirname(file), { recursive: true });
		const temporary = `${file}.${randomUUID()}.tmp`;
		try {
			await fs.writeFile(temporary, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }));
			// Linking publishes the complete file only if the destination does not exist.
			try { await fs.link(temporary, file); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		} finally { await fs.rm(temporary, { force: true }); }
		return (await this.state(state.id))!;
	}
	async claim(id: string, projectId?: string) {
		const state = await this.state(id);
		if (!state || state.status !== "queued" || (this.kind === "frames" && state.projectId !== projectId)) return null;
		const token = randomUUID();
		try { await fs.writeFile(this.claimPath(id), JSON.stringify({ token }), { flag: "wx" }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return null; throw error; }
		await this.write({ ...state, status: "running" });
		return token;
	}
	async owns(id: string, token: unknown) {
		const claim = await readJson<{ token: string }>(this.claimPath(id));
		const state = await this.state(id);
		return typeof token === "string" && token === claim?.token && state?.status === "running";
	}
	async update(id: string, token: unknown, patch: Record<string, unknown>) {
		if (!await this.owns(id, token)) throw new Error("Request is not owned by this worker");
		const state = (await this.state(id))!;
		await this.write({ ...state, ...patch, id, projectId: state.projectId ?? (typeof patch.projectId === "string" ? patch.projectId : undefined) });
	}
}
