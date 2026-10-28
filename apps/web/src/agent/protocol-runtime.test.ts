import { afterEach, expect, mock, test } from "bun:test";
import type { TProject } from "@/project/types";
import { buildDefaultScene } from "@/timeline/scenes";
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { EditorCore } = await import("@/core");
const { runFrameRequest, currentFrameRevision } = await import("./frames");
const { applyDraft } = await import("./bridge");
const { buildBundleScenes } = await import("./importer");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; EditorCore.reset(); });

function setup() {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop(); editor.save.pause();
	const scene = buildDefaultScene({ name: "Scene", isMain: true });
	scene.tracks = buildBundleScenes({
		bundle: { name: "Test", width: 640, height: 360, assets: [], main: [], audio: [], overlay: [{ name: "Shapes", type: "graphic", elements: [{ name: "Box", agent_id: "box", start: 0, duration: 4, graphic: { definitionId: "rectangle" }, size: [200, 100] }] }] },
		media: new Map(), sceneId: scene.id,
	}).tracks;
	const project: TProject = { metadata: { id: "p", name: "Project", duration: scene.tracks.overlay[0].elements[0].duration, createdAt: new Date(), updatedAt: new Date() }, scenes: [scene], currentSceneId: scene.id, version: 31, settings: { canvasSize: { width: 640, height: 360 }, fps: { numerator: 30, denominator: 1 }, background: { type: "color", color: "#000000" } } };
	editor.project.setActiveProject({ project });
	editor.scenes.setScenes({ scenes: [scene], activeSceneId: scene.id });
	const requests: { url: string; body: Record<string, unknown> }[] = [];
	globalThis.fetch = (async (url, init) => { requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) }); return Response.json({ ok: true }); }) as typeof fetch;
	return { editor, scene, requests };
}

test("stale snapshotHash/rev and wrong project are refused before rendering", async () => {
	const { editor, requests } = setup();
	let renders = 0;
	editor.renderer.createSnapshot = async () => { renders++; return { success: false, error: "Unexpected render" }; };
	for (const expected of [{ snapshotHash: "old" }, { rev: "old" }, { projectId: "other" }]) {
		await runFrameRequest({ id: "stale", projectId: "p", times: [0], ...expected }, "token");
	}
	expect(renders).toBe(0);
	expect(requests.map((r) => r.body.status)).toEqual(["stale", "stale", "stale"]);
});
test("a timeline edit during an asynchronous render ends the batch as stale", async () => {
	const { editor, scene, requests } = setup();
	editor.renderer.createSnapshot = async () => {
		editor.scenes.setScenes({ scenes: [{ ...scene, tracks: { ...scene.tracks, main: { ...scene.tracks.main, hidden: true } } }], activeSceneId: scene.id });
		return { success: false, error: "Render interrupted" };
	};
	await runFrameRequest({ id: "changed", projectId: "p", times: [0, 1], snapshotHash: currentFrameRevision().snapshotHash }, "token");
	expect(requests.at(-1)?.body).toMatchObject({ status: "stale" });
	expect(requests.some((r) => r.body.index !== undefined)).toBe(false);
});
test("legacy rev remains a capture ID and per-frame failures advance to a terminal error", async () => {
	const { editor, requests } = setup();
	editor.renderer.createSnapshot = async () => ({ success: false, error: "Decoder failed" });
	await runFrameRequest({ id: "legacy", projectId: "p", times: [0, 1], rev: "capture-id", legacy: true }, "token");
	expect(requests.filter((r) => r.body.index !== undefined).map((r) => r.body)).toMatchObject([{ index: 0, error: "Decoder failed" }, { index: 1, error: "Decoder failed" }]);
	expect(requests.at(-1)?.body.status).toBe("error");
});
test("public draft entry point accepts make-compound and attaches bounds warnings to applied results", async () => {
	const { requests } = setup();
	await applyDraft({ schema: "opencut-agent-draft-1", rev: "adapter", ops: [
		{ op: "set", match: { agentId: "box" }, params: { "transform.positionX": 2000 } },
		{ op: "make-compound", name: "Clip", match: [{ agentId: "box" }] },
	] });
	const result = requests.find((r) => r.url.endsWith("/applied"))?.body.results as { op: string; ok: boolean; warnings?: { code: string }[] }[];
	expect(result[1]).toMatchObject({ op: "make-compound", ok: true });
	expect(result[1].warnings?.[0].code).toBe("mostly-off-canvas");
});
