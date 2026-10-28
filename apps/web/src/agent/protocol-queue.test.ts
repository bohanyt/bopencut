import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { RequestQueue } from "./request-queue";
import { nextFrameRequest, writeQueuedFrame } from "./frame-queue";
import { nextImportRequest } from "./import-queue";
import { readAgentBundle } from "./bundle-files";
import { resolveAgentFile, writeAtomic } from "./workspace-files";
import { validateFrameRequest } from "./frame-protocol";
import { validateBundle } from "./bundle-schema";

let root: string;
beforeAll(async () => {
	await fs.mkdir("workspace", { recursive: true });
	root = await fs.mkdtemp(path.resolve("workspace", "protocol-test-"));
});
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });
const write = (file: string, value: unknown) => writeAtomic(path.join(root, file), JSON.stringify(value));
const minimal = { schema: "legacy-producer", name: "Test", width: 640, height: 360, assets: [], main: [], overlay: [], audio: [] };

describe("frame queue v2", () => {
	test("rejects v2 requests without a project and invalid dimensions", () => {
		expect(() => validateFrameRequest({ times: [0] }, "missing-project")).toThrow("projectId");
		expect(() => validateFrameRequest({ projectId: "a", times: [0], width: 4097 }, "bad-width")).toThrow("width");
	});
	test("orders matching projects and atomically claims only one tab", async () => {
		await write("frames/requests/first.json", { projectId: "a", times: [0, 1] });
		await write("frames/requests/second.json", { projectId: "b", times: [0] });
		await write("frames/requests/third.json", { projectId: "a", times: [0] });
		expect((await nextFrameRequest(root, "a"))?.id).toBe("first");
		expect((await nextFrameRequest(root, "b"))?.id).toBe("second");
		const q = new RequestQueue(root, "frames");
		expect((await q.state("second"))?.status).toBe("queued");
		expect(await q.claim("first", "b")).toBeNull();
		const claims = await Promise.all([q.claim("first", "a"), q.claim("first", "a")]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		expect(await nextFrameRequest(root, "a")).toBeNull();
		const token = claims.find(Boolean)!;
		const form = new FormData();
		form.set("id", "first"); form.set("token", token); form.set("index", "0");
		form.set("image", new File(["jpeg-fixture"], "frame.jpg", { type: "image/jpeg" }));
		await writeQueuedFrame(root, form);
		expect(await q.state("first")).toMatchObject({ status: "running", done: 1, total: 2, files: ["frames/first/0.jpg"] });
		await expect(writeQueuedFrame(root, form)).rejects.toThrow("index");
		await q.update("first", token, { status: "error", done: 2, errors: [{ index: 1, time: 1, error: "Render failed" }] });
		expect((await nextFrameRequest(root, "a"))?.id).toBe("third");
		await expect(q.update("first", token, { status: "done" })).rejects.toThrow("owned");
	});
	test("legacy single-file request targets last sync once and keeps rev", async () => {
		await write("project.json", { projectId: "legacy-target" });
		await write("frames-request.json", { rev: "legacy-capture", times: [0.5] });
		expect(await nextFrameRequest(root, "other")).toBeNull();
		await write("project.json", { projectId: "other" });
		expect(await nextFrameRequest(root, "legacy-target")).toMatchObject({ id: "legacy-capture", projectId: "legacy-target", legacy: true, rev: "legacy-capture" });
	});
	test("invalid queued requests get an error and do not block later jobs", async () => {
		await write("frames/requests/invalid.json", { times: [0] });
		await nextFrameRequest(root, "a");
		expect(await new RequestQueue(root, "frames").state("invalid")).toMatchObject({ status: "error", done: 0 });
	});
});

describe("named bundles and import requests", () => {
	test("accepts legacy layouts and rejects invalid schema or unknown assets before import", () => {
		expect(validateBundle(minimal).name).toBe("Test");
		expect(() => validateBundle({ ...minimal, width: 0 })).toThrow();
		expect(() => validateBundle({ ...minimal, main: [{ name: "Missing", asset: "missing", start: 0, duration: 1 }] })).toThrow("Unknown asset");
		expect(() => validateBundle({ ...minimal, fonts: [{ family: "Local" }] })).toThrow();
	});
	test("reads named bundles from either root and validates every file before creating anything", async () => {
		const files = path.join(root, "source");
		await fs.mkdir(files, { recursive: true });
		await write("named/bundle.json", minimal);
		await write("source/alternate.json", { ...minimal, assets: [{ key: "bad", path: "missing.png", type: "image", name: "Missing" }] });
		expect((await readAgentBundle("named", root, files)).ok).toBe(true);
		const invalid = await readAgentBundle("alternate.json", root, files);
		expect(invalid).toMatchObject({ ok: false, assets: [{ key: "bad", ok: false }] });
		await expect(resolveAgentFile("../outside.json", root, files)).rejects.toThrow("outside");
	});
	test("import queue ignores result files, handles invalid requests, and claims once", async () => {
		await write("imports/import-a.json", { bundlePath: "named/bundle.json", name: "Named import" });
		await write("imports/import-invalid.json", { bundlePath: 42 });
		expect(await nextImportRequest(root)).toMatchObject({ id: "import-a", name: "Named import" });
		const q = new RequestQueue(root, "imports");
		const token = await q.claim("import-a");
		expect(token).toBeString();
		expect(await q.claim("import-a")).toBeNull();
		await q.update("import-a", token, { status: "done", projectId: "created", assets: [] });
		expect(await nextImportRequest(root)).toBeNull();
		expect(await q.state("import-invalid")).toMatchObject({ status: "error" });
	});
});
