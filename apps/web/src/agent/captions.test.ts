import { describe, expect, mock, test } from "bun:test";
import { resolveCaptionPreset } from "./captions";
import { buildDefaultScene } from "@/timeline/scenes";
import type { TextElement } from "@/timeline";
import type { AgentElement } from "./elements";
import { buildSceneSnapshot } from "./snapshot";
import { applyElementUpdate } from "@/timeline/update-pipeline";

mock.module("@/services/renderer/compositor/wasm-compositor", () => ({
	wasmCompositor: {},
}));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
const { buildBundleScenes } = await import("./importer");
const { computeAgentDraft } = await import("./draft");

const canvas = { width: 1280, height: 720 };
const phrase = (index = 0): AgentElement => ({
	agent_id: `caption-${index}`,
	name: "Caption",
	start: index * 3,
	duration: 3,
	caption: {
		text: "A simple phrase",
		highlight: { color: "#00ff00", scale: 1.1 },
		style: { "stroke.inner.width": 0.1, "stroke.outer.width": 0.2 },
	},
});

describe("agent captions", () => {
	test("bundle builds 70 phrases on one text track with native metadata and keyframes", () => {
		const first = phrase();
		first.keyframes = [
			{ path: "shadow.opacity", time: 0, value: 0 },
			{ path: "shadow.opacity", time: 1, value: 0.8 },
		];
		const built = buildBundleScenes({
			bundle: {
				name: "Captions",
				...canvas,
				assets: [],
				main: [],
				audio: [],
				overlay: [
					{
						name: "Captions",
						type: "text",
						elements: [
							first,
							...Array.from({ length: 69 }, (_, i) => phrase(i + 1)),
						],
					},
				],
			},
			media: new Map(),
			sceneId: "main",
		});
		expect(built.tracks.overlay).toHaveLength(1);
		expect(built.tracks.overlay[0].elements).toHaveLength(70);
		const el = built.tracks.overlay[0].elements[0] as TextElement;
		expect(el.type).toBe("text");
		expect(el.caption?.words).toHaveLength(3);
		expect(el.animations?.["shadow.opacity"]).toBeDefined();
		expect(el.params["caption.activeColor"]).toBe("#00ff00");
	});
	test("draft add infers text track; set changes words/styles and snapshot reports seconds", () => {
		const scene = buildDefaultScene({ name: "Main", isMain: true });
		const added = computeAgentDraft({
			scenes: [scene],
			rootSceneId: scene.id,
			ops: [{ op: "add", track: { name: "Captions" }, element: phrase() }],
			canvas,
			mediaFor: () => undefined,
			fps: { numerator: 30, denominator: 1 },
			ripple: false,
		});
		expect(added.results[0].ok).toBe(true);
		expect(added.scenes[0].tracks.overlay[0].type).toBe("text");
		const changed = computeAgentDraft({
			scenes: added.scenes,
			rootSceneId: scene.id,
			ops: [
				{
					op: "set",
					match: { agentId: "caption-0" },
					caption: {
						text: "A new phrase",
						style: { "shadow.blur": 8 },
						words: [
							{ text: "A", start: 0, end: 0.5 },
							{ text: "new", start: 0.5, end: 2, highlight: true },
							{ text: "phrase", start: 2, end: 3 },
						],
					},
				},
			],
			canvas,
			mediaFor: () => undefined,
			fps: { numerator: 30, denominator: 1 },
			ripple: false,
		});
		expect(changed.results[0].ok).toBe(true);
		const snapshot = buildSceneSnapshot({
			scenes: changed.scenes,
			rootSceneId: scene.id,
			mediaName: new Map(),
		});
		expect(snapshot.tracks[0].elements[0].caption).toMatchObject({
			text: "A new phrase",
			approximate: false,
			words: [
				{ text: "A", start: 0, end: 0.5 },
				{ text: "new", start: 0.5, end: 2, highlight: true },
				{ text: "phrase", start: 2, end: 3 },
			],
		});
	});
	test("preset references resolve with inline override and reject unknown names", () => {
		const caption = resolveCaptionPreset(
			{ text: "Readable text", preset: "Readable", style: { fontSize: 6 } },
			[{ name: "Readable", style: { fontSize: 5, "shadow.opacity": 0.7 } }],
		);
		expect(caption.style).toEqual({ fontSize: 6, "shadow.opacity": 0.7 });
		expect(caption.preset).toBeUndefined();
		expect(() =>
			resolveCaptionPreset({ text: "Text", preset: "Missing" }, []),
		).toThrow("not found");
	});
	test("ordinary text content updates reconcile caption timings through the command pipeline", () => {
		const scene = buildDefaultScene({ name: "Main", isMain: true });
		const built = buildBundleScenes({
			bundle: {
				name: "Caption",
				...canvas,
				assets: [],
				main: [],
				audio: [],
				overlay: [{ name: "Captions", type: "text", elements: [phrase()] }],
			},
			media: new Map(),
			sceneId: scene.id,
		});
		const el = built.tracks.overlay[0].elements[0] as TextElement;
		const next = applyElementUpdate({
			element: el,
			patch: { params: { content: "A revised phrase" } },
			context: { tracks: built.tracks, trackId: built.tracks.overlay[0].id },
		}) as TextElement;
		expect(next.caption?.words.map(({ text }) => text)).toEqual([
			"A",
			"revised",
			"phrase",
		]);
		expect(next.caption?.words[2]).toEqual(el.caption?.words[2]);
	});
});
