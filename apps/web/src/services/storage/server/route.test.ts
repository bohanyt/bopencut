import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET, PUT, DELETE } from "../../../app/api/storage/[...slug]/route";

let root: string;
let previous: string | undefined;
beforeAll(async () => {
	previous = process.env.BOPENCUT_DATA;
	root = await fs.mkdtemp(path.join(os.tmpdir(), "bopencut-route-"));
	process.env.BOPENCUT_DATA = root;
});
afterAll(async () => {
	if (previous === undefined) delete process.env.BOPENCUT_DATA;
	else process.env.BOPENCUT_DATA = previous;
	await fs.rm(root, { recursive: true, force: true });
});
const ctx = (id: string) => ({
	params: Promise.resolve({ slug: ["projects", id] }),
});
const request = (
	id: string,
	method: string,
	headers: Record<string, string> = {},
	body?: unknown,
) =>
	new Request(`http://127.0.0.1:3021/api/storage/projects/${id}`, {
		method,
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

describe("adapter proyek", () => {
	test("mendeteksi revisi lama dan migrasi tidak menghidupkan proyek yang dihapus", async () => {
		const id = "test-project";
		const first = { metadata: { id, name: "awal" } };
		const created = await PUT(
			request(id, "PUT", { "if-match": "new" }, first),
			ctx(id),
		);
		expect(created.status).toBe(200);
		const old = created.headers.get("etag")!;
		const updated = await PUT(
			request(
				id,
				"PUT",
				{ "if-match": old },
				{ metadata: { id, name: "baru" } },
			),
			ctx(id),
		);
		expect(updated.status).toBe(200);
		expect(
			(await PUT(request(id, "PUT", { "if-match": old }, first), ctx(id)))
				.status,
		).toBe(409);
		expect((await GET(request(id, "GET"), ctx(id))).status).toBe(200);
		await DELETE(request(id, "DELETE"), ctx(id));
		const migration = await PUT(
			request(id, "PUT", { "x-migration": "1" }, first),
			ctx(id),
		);
		expect((await migration.json()).skipped).toBe(true);
		expect((await GET(request(id, "GET"), ctx(id))).status).toBe(404);
	});
	test("menolak origin asing dan ID traversal", async () => {
		expect(
			(
				await GET(
					request("valid", "GET", { origin: "https://example.com" }),
					ctx("valid"),
				)
			).status,
		).toBe(403);
		expect((await GET(request("valid", "GET"), ctx("../escape"))).status).toBe(
			400,
		);
	});
});
