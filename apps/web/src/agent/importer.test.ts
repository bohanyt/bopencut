import { afterEach, describe, expect, mock, test } from "bun:test";
import type { TProject } from "@/project/types";
import type { MediaAsset } from "@/media/types";
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { importAgentBundle, BundleImportError } = await import("./importer");
const { EditorCore } = await import("@/core");
afterEach(() => EditorCore.reset());
const bundle = { name: "Import test", width: 640, height: 360, assets: [], main: [], audio: [], overlay: [{ name: "Shapes", type: "graphic", elements: [{ name: "Box", start: 0, duration: 2, graphic: { definitionId: "rectangle" } }] }] };

function dependencies() {
	const calls = { projects: [] as TProject[], media: [] as MediaAsset[], deleted: [] as string[], deletedMedia: [] as string[], urls: [] as string[] };
	return {
		calls,
		storage: {
			saveProject: async ({ project }: { project: TProject }) => { calls.projects.push(project); },
			saveMediaAsset: async ({ mediaAsset }: { projectId: string; mediaAsset: MediaAsset }) => { calls.media.push(mediaAsset); },
			deleteProject: async ({ id }: { id: string }) => { calls.deleted.push(id); },
			deleteProjectMedia: async ({ projectId }: { projectId: string }) => { calls.deletedMedia.push(projectId); },
		},
		request: async (url: string): Promise<Response> => { calls.urls.push(url); return Response.json(bundle); },
		process: async () => [{ name: "Image", type: "image" as const, width: 32, height: 32, file: new File(["image"], "image.png") }],
	};
}

async function failure(run: () => Promise<unknown>) {
 try { await run(); return null; } catch (error) { return error; }
}

describe("isolated bundle imports", () => {
	test("validates missing files and schema before writing a project or media", async () => {
		const deps = dependencies();
		deps.request = async () => Response.json({ error: "Missing file", assets: [{ key: "image", ok: false }] }, { status: 400 });
		expect(await failure(() => importAgentBundle({ onStatus: () => {} }, deps))).toBeInstanceOf(BundleImportError);
		deps.request = async () => Response.json({ ...bundle, width: -1 });
		expect(await failure(() => importAgentBundle({ onStatus: () => {} }, deps))).toBeInstanceOf(Error);
		expect(deps.calls.projects).toHaveLength(0);
		expect(deps.calls.media).toHaveLength(0);
	});
	test("saves a complete named project without switching the active editor", async () => {
		const deps = dependencies();
		const editor = EditorCore.getInstance();
		editor.save.stop();
		const before = editor.project.getActiveOrNull();
		const id = await importAgentBundle({ onStatus: () => {}, bundlePath: "named/bundle.json", name: "Override" }, deps);
		expect(editor.project.getActiveOrNull()).toBe(before);
		expect(deps.calls.projects[0]).toMatchObject({ metadata: { id, name: "Override" }, settings: { canvasSize: { width: 640, height: 360 } } });
		expect(deps.calls.projects[0].scenes[0].tracks.overlay[0].elements).toHaveLength(1);
		expect(deps.calls.urls[0]).toContain("named%2Fbundle.json");
	});
	test("timeline failure rolls back staged assets and never publishes a half-built project", async () => {
		const deps = dependencies();
		const broken = { ...bundle, assets: [{ key: "image", path: "image.png", name: "Image", type: "image" }], main: [{ name: "Empty compound", start: 0, duration: 2, compound: {} }] };
		deps.request = async (input) => input.includes("/bundle") ? Response.json(broken) : new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
		expect(String(await failure(() => importAgentBundle({ onStatus: () => {} }, deps)))).toContain("no content");
		expect(deps.calls.media).toHaveLength(1);
		expect(deps.calls.projects).toHaveLength(0);
		expect(deps.calls.deleted).toHaveLength(1);
		expect(deps.calls.deletedMedia).toEqual(deps.calls.deleted);
	});
	test("failed final save also cleans up the new project", async () => {
		const deps = dependencies();
		deps.storage.saveProject = async () => { throw new Error("Disk full"); };
		expect(String(await failure(() => importAgentBundle({ onStatus: () => {} }, deps)))).toContain("Disk full");
		expect(deps.calls.deleted).toHaveLength(1);
	});
});
