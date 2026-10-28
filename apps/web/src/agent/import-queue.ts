import { RequestQueue } from "./request-queue";
import { readJson } from "./workspace-files";

export type ImportRequest = { id: string; bundlePath: string; name?: string };
export async function nextImportRequest(workspace: string): Promise<ImportRequest | null> {
	const queue = new RequestQueue(workspace, "imports");
	const entries = await queue.entries();
	for (const { id, file } of entries) {
		if (await queue.state(id)) continue;
		try {
			const request = await readJson<Record<string, unknown>>(file);
			if (!request || typeof request.bundlePath !== "string" || !request.bundlePath.trim() || (request.name !== undefined && (typeof request.name !== "string" || !request.name.trim()))) throw new Error("Import needs bundlePath and an optional nonempty name");
			await queue.initialize({ id, status: "queued", request: { ...request, id }, assets: [] });
		} catch (error) { await queue.initialize({ id, status: "error", error: String(error), assets: [] }); }
	}
	for (const { id } of entries) {
		const state = await queue.state(id);
		if (state?.status === "running") return null;
		if (state?.status === "queued") return state.request as ImportRequest;
	}
	return null;
}
