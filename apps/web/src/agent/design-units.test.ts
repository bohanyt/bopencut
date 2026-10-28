import { describe, expect, mock, test } from "bun:test";
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({ gpuRenderer: {}, initializeGpuRenderer: async () => {}, isGpuAvailable: () => false }));
const { buildAgentElement } = await import("./elements");
const { buildBundleScenes } = await import("./importer");
import { mediaFitScale, convertDesignUnits } from "./design-units";
import { visibleBoundsFraction, normalizeDraftOps, withBoundsWarnings } from "./draft-adapter";
import { buildDefaultScene } from "@/timeline/scenes";
import { computeAgentDraft } from "./draft";
import { frameRevision, expectsDifferentTimeline } from "./frame-protocol";
import type { ParamValues } from "@/params";
import type { Bundle } from "./importer";
import type { TProjectSettings } from "@/project/types";

const canvas = { width: 1920, height: 1080 };
const settings: TProjectSettings = { canvasSize: canvas, fps: { numerator: 30, denominator: 1 }, background: { type: "color", color: "#000000" } };
describe("size fit modes", () => {
	for (const source of [{ width: 600, height: 1000 }, { width: 600, height: 600 }, { width: 1920, height: 1080 }]) {
		test(`contain honors both bounds for ${source.width}x${source.height}`, () => {
			const scale = mediaFitScale([1420, 800], source, canvas, "contain");
			const base = Math.min(canvas.width / source.width, canvas.height / source.height);
			expect(source.width * scale * base).toBeLessThanOrEqual(1420.0001);
			expect(source.height * scale * base).toBeLessThanOrEqual(800.0001);
		});
	}
	test("width remains the legacy default and cover fills both dimensions", () => {
		const source = { width: 600, height: 1000 };
		expect(mediaFitScale([1420, 800], source, canvas)).toBe(mediaFitScale([1420, 800], source, canvas, "width"));
		expect(mediaFitScale([1420, 800], source, canvas, "cover")).toBeGreaterThan(mediaFitScale([1420, 800], source, canvas, "contain"));
		const el = buildAgentElement({ e: { name: "Portrait", asset: "a", start: 0, duration: 2, size: [1420, 800], fit: "contain" }, media: { ...source, id: "a", type: "image" }, trackId: "t", canvas, keyframes: [] });
		expect(el.params["transform.scaleY"]).toBeCloseTo(800 / 1080);
	});
});
describe("pixel design units", () => {
	test("fontSizePx converts the em size at 1080p while native fontSize stays unchanged", () => {
		const native = { fontSize: 6 };
		convertDesignUnits(native, canvas, "text");
		expect(native.fontSize).toBe(6);
		const el = buildAgentElement({ e: { text: "Text", name: "Text", start: 0, duration: 1, params: { fontSizePx: 72 } }, trackId: "text", canvas, keyframes: [] });
		expect(el.params.fontSize).toBe(6);
		expect(el.params.fontSizePx).toBeUndefined();
	});
	test("stroke and rectangle radius pixels account for source size, nonuniform scale and stroke inset", () => {
		const el = buildAgentElement({ e: { name: "Box", graphic: { definitionId: "rectangle", params: { strokeWidthPx: 4, cornerRadiusPx: 12 } }, size: [400, 200], start: 0, duration: 1 }, trackId: "g", canvas, keyframes: [] });
		const scale = 200 / 512;
		expect(el.params.strokeWidth * scale).toBeCloseTo(4);
		expect((512 - el.params.strokeWidth) * scale * el.params.cornerRadius / 100).toBeCloseTo(12);
		expect(el.params.cornerRadiusPx).toBeUndefined();
	});
	test("rejects invalid pixel aliases and preserves native graphic units", () => {
		const native: ParamValues = { strokeWidth: 4, cornerRadius: 20 };
		convertDesignUnits(native, canvas, "rectangle");
		expect(native).toEqual({ strokeWidth: 4, cornerRadius: 20 });
		expect(() => convertDesignUnits({ fontSizePx: -1 }, canvas, "text")).toThrow();
	});
	test("bounds warning reports mostly off-canvas elements without changing the draft", () => {
		const scene = buildDefaultScene({ name: "Scene", isMain: true });
		const ops = [{ op: "add" as const, track: { name: "Shapes", type: "graphic" as const }, element: { name: "Outside", start: 0, duration: 1, size: [200, 200] as [number, number], graphic: { definitionId: "rectangle" }, params: { "transform.positionX": 2000 } } }];
		const outcome = computeAgentDraft({ scenes: [scene], rootSceneId: scene.id, ops, canvas, fps: settings.fps, ripple: false, mediaFor: () => undefined });
		const result = withBoundsWarnings(outcome.results, outcome.scenes, canvas, [], ops);
		expect(result[0]).toMatchObject({ ok: true, warnings: [{ code: "mostly-off-canvas", visibleFraction: 0 }] });
		expect(visibleBoundsFraction({ cx: 960, cy: 540, width: 100, height: 100, rotation: 45 }, canvas)).toBeCloseTo(1);
	});
});
test("make-compound and deprecated group produce the same compound behavior; visual group stays groupId", () => {
	const scene = buildDefaultScene({ name: "Scene", isMain: true });
	const bundle: Bundle = { name: "Test", ...canvas, assets: [], main: [], audio: [], overlay: [{ name: "Shapes", type: "graphic", elements: [{ name: "Box", agent_id: "box", graphic: { definitionId: "rectangle" }, group: "visual", start: 0, duration: 2 }] }] };
	const built = buildBundleScenes({ bundle, media: new Map(), sceneId: scene.id });
	scene.tracks = built.tracks;
	expect(scene.tracks.overlay[0].elements[0].groupId).toBe("visual");
	for (const op of ["make-compound", "group"] as const) {
		const ops = normalizeDraftOps([{ op, match: [{ agentId: "box" }], name: "Clip" }]);
		const outcome = computeAgentDraft({ scenes: [scene], rootSceneId: scene.id, ops, canvas, fps: settings.fps, ripple: false, mediaFor: () => undefined });
		expect(outcome.results[0].ok).toBe(true);
		expect(outcome.scenes).toHaveLength(2);
	}
});
test("frame fingerprints ignore navigation dates but include keyframes, nested tracks and settings", () => {
	const scene = buildDefaultScene({ name: "Scene", isMain: true });
	const built = buildBundleScenes({ bundle: { name: "Test", ...canvas, assets: [], audio: [], overlay: [], main: [{ name: "Nested", start: 0, duration: 2, compound: { overlay: [{ name: "Shapes", type: "graphic", elements: [{ name: "Box", start: 0, duration: 2, graphic: { definitionId: "rectangle" } }] }] } }] }, media: new Map(), sceneId: scene.id });
	const scenes = [{ ...scene, tracks: built.tracks }, ...built.scenes];
	const nestedHash = frameRevision(scenes, scene.id, settings).snapshotHash;
	scenes[1].tracks.overlay[0].elements[0].params["transform.positionX"] = 20;
	expect(frameRevision(scenes, scene.id, settings).snapshotHash).not.toBe(nestedHash);
	const hash = frameRevision([scene], scene.id, settings).snapshotHash;
	expect(frameRevision([{ ...scene, updatedAt: new Date(1234) }], scene.id, settings).snapshotHash).toBe(hash);
	expect(frameRevision([scene], scene.id, { ...settings, background: { type: "color", color: "#ffffff" } }).snapshotHash).not.toBe(hash);
	expect(expectsDifferentTimeline({ id: "test", projectId: "p", times: [0], rev: hash }, hash)).toBe(false);
	expect(expectsDifferentTimeline({ id: "test", projectId: "p", times: [0], snapshotHash: "old" }, hash)).toBe(true);
	expect(expectsDifferentTimeline({ id: "legacy", projectId: "p", times: [0], rev: "capture", legacy: true }, hash)).toBe(false);
});
