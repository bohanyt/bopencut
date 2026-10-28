import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	atomicWrite,
	mediaResponse,
	projectDir,
	readJson,
	revision,
	safeId,
	saveMedia,
	withProjectLock,
} from "./files";

let root: string;
let previous: string | undefined;
beforeAll(async () => {
	previous = process.env.BOPENCUT_DATA;
	root = await fs.mkdtemp(path.join(os.tmpdir(), "bopencut-test-"));
	process.env.BOPENCUT_DATA = root;
});
afterAll(async () => {
	if (previous === undefined) delete process.env.BOPENCUT_DATA;
	else process.env.BOPENCUT_DATA = previous;
	await fs.rm(root, { recursive: true, force: true });
});

describe("penyimpanan folder", () => {
	test("menolak traversal dan ID yang bukan nama aman", () => {
		for (const id of ["../lain", "..", "a/b", "a\\b", "C:foo", "", "a.b"])
			expect(() => safeId(id)).toThrow();
		expect(safeId("abc-123_ok")).toBe("abc-123_ok");
	});
	test("penulisan atomik dan antrean revisi", async () => {
		const file = path.join(projectDir("project-1"), "project.json");
		await Promise.all(
			Array.from({ length: 10 }, (_, n) =>
				withProjectLock("project-1", async () => {
					const old = await readJson(file);
					await atomicWrite(
						file,
						JSON.stringify({ count: (old?.count ?? 0) + 1, n }),
					);
				}),
			),
		);
		const value = await readJson(file);
		expect(value.count).toBe(10);
		expect(revision(value)).toBe(revision(JSON.parse(JSON.stringify(value))));
		expect(
			(await fs.readdir(path.dirname(file))).some((name) =>
				name.endsWith(".tmp"),
			),
		).toBe(false);
	});
	test("media ditulis sekali dan range dapat dibaca", async () => {
		const meta = {
			id: "media-1",
			fileName: "contoh.mp4",
			fileType: "video/mp4",
		};
		await saveMedia(
			"project-1",
			meta.id,
			meta,
			new Blob(["0123456789"]).stream(),
		);
		await saveMedia(
			"project-1",
			meta.id,
			meta,
			new Blob(["overwritten"]).stream(),
		);
		const response = await mediaResponse("project-1", meta.id, "bytes=2-5");
		expect(response.status).toBe(206);
		expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
		expect(await response.text()).toBe("2345");
		expect(
			(await mediaResponse("project-1", meta.id, "bytes=99-")).status,
		).toBe(416);
	});
});
