import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	atomicWrite,
	retryTransient,
	mediaResponse,
	projectDir,
	readJson,
	removeMedia,
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

describe("folder storage", () => {
	test("rejects traversal and unsafe IDs", () => {
		for (const id of ["../lain", "..", "a/b", "a\\b", "C:foo", "", "a.b"])
			expect(() => safeId(id)).toThrow();
		expect(safeId("abc-123_ok")).toBe("abc-123_ok");
	});
	test("atomic writes and revision queue", async () => {
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
	test("writes media once and reads ranges", async () => {
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
	test("retries transient Windows lock errors with backoff, not other errors", async () => {
		const delays: number[] = [];
		const sleep = async (ms: number) => { delays.push(ms); };
		const locked = (code: string) => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
		let calls = 0;
		const value = await retryTransient(async () => {
			if (++calls < 4) throw locked(["EPERM", "EBUSY", "EACCES"][calls - 1]);
			return "renamed";
		}, { sleep });
		expect(value).toBe("renamed");
		expect(delays).toEqual([10, 20, 40]);

		calls = 0;
		await expect(retryTransient(async () => { calls++; throw locked("EPERM"); }, { attempts: 3, sleep })).rejects.toThrow("EPERM");
		expect(calls).toBe(3);

		calls = 0;
		await expect(retryTransient(async () => { calls++; throw locked("ENOSPC"); }, { sleep })).rejects.toThrow("ENOSPC");
		expect(calls).toBe(1);
	});
	test("concurrent writes to one file are serialized while it is being read", async () => {
		const file = path.join(projectDir("project-2"), "media", "_metadata", "logo.json");
		const reads: Promise<unknown>[] = [];
		await Promise.all(
			Array.from({ length: 40 }, (_, n) => {
				reads.push(readJson(file));
				return atomicWrite(file, JSON.stringify({ n, pad: "x".repeat(20000) }));
			}),
		);
		await Promise.all(reads);
		expect((await readJson(file)).n).toBe(39);
		expect(
			(await fs.readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")),
		).toEqual([]);
	});
	test("removing media also deletes a file whose metadata was never written", async () => {
		const dir = path.join(projectDir("project-3"), "media");
		await fs.mkdir(path.join(dir, "_metadata"), { recursive: true });
		// A save that wrote the file, then failed writing its metadata.
		await fs.writeFile(path.join(dir, "half.png"), "png");
		await fs.writeFile(path.join(dir, "other.png"), "png");
		await removeMedia("project-3", "half");
		expect((await fs.readdir(dir)).sort()).toEqual(["_metadata", "other.png"]);
		// With metadata: the file it names and the metadata go.
		await saveMedia("project-3", "whole", { id: "whole", fileName: "w.jpg", fileType: "image/jpeg" }, new Blob(["jpg"]).stream());
		await removeMedia("project-3", "whole");
		expect((await fs.readdir(dir)).sort()).toEqual(["_metadata", "other.png"]);
		expect(await fs.readdir(path.join(dir, "_metadata"))).toEqual([]);
	});
});
