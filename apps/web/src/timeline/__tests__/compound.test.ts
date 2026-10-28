import { describe, expect, test } from "bun:test";
import type {
	AudioElement,
	CompoundElement,
	GraphicElement,
	SceneTracks,
	TScene,
	TextElement,
	TimelineElement,
	TimelineTrack,
	VideoElement,
} from "@/timeline";
import {
	assertNoCompoundCycle,
	buildCompoundFromElements,
	CompoundCycleError,
	expandCompoundAudioTracks,
	getCompoundTrackType,
	getUserScenes,
	ungroupCompoundElement,
} from "@/timeline/compound";
import { buildScene } from "@/services/renderer/scene-builder";
import { CompoundNode } from "@/services/renderer/nodes/compound-node";
import {
	allElements,
	allTracks,
	findCompound,
	fixture,
	getHost,
	layout,
	refs,
	t,
} from "./compound-fixtures";

describe("compound clip", () => {
	test("create from 3 elements on 2 tracks + 1 audio keeps relative timing and track order", () => {
		const result = buildCompoundFromElements({ scenes: fixture(), hostSceneId: "main", elements: refs });
		const nested = result.scenes.find((s) => s.id === result.sceneId) as TScene;
		expect(nested.kind).toBe("compound");
		expect(nested.isMain).toBe(false);
		// Earliest start (box, 1 s) becomes nested time 0.
		const nestedLayout = layout(nested.tracks);
		expect(nestedLayout.map(({ type, elements }) => ({ type, elements }))).toEqual([
			{ type: "text", elements: [["title", t(1), t(3), 0, 0]] },
			{ type: "graphic", elements: [["box", t(0), t(4), 0, 0]] },
			{ type: "video", elements: [] },
			{ type: "audio", elements: [["music", t(0.5), t(2), 0, 0]] },
		]);
		// Nested tracks get fresh ids; compoundOrigin maps them back to the host tracks.
		expect(nestedLayout.map(({ id }) => nested.compoundOrigin?.trackSources[id])).toEqual([
			"t-text",
			"t-gfx",
			"t-main",
			"t-music",
		]);
		expect(nested.compoundOrigin?.hostTrackOrder).toEqual(["t-text", "t-gfx", "t-main", "t-music"]);

		const compound = findCompound(result.scenes);
		expect(compound.startTime).toBe(t(1));
		expect(compound.duration).toBe(t(4));
		expect(compound.sourceDuration).toBe(t(4));
		expect(compound.sceneId).toBe(result.sceneId);
		expect(compound.params.volume).toBe(0);
		expect(compound.params.opacity).toBe(1);

		const host = getHost(result.scenes);
		// Visual content → video overlay track where the top source track was; emptied tracks removed.
		expect(host.tracks.overlay).toHaveLength(1);
		expect(host.tracks.overlay[0].type).toBe("video");
		expect(host.tracks.overlay[0].id).toBe(result.compound.trackId);
		expect(host.tracks.audio).toHaveLength(0);
		expect(host.tracks.main.elements.map((e) => e.id)).toEqual(["bg"]);
		expect(getUserScenes({ scenes: result.scenes }).map((s) => s.id)).toEqual(["main"]);
	});

	test("ungroup restores the original layout exactly", () => {
		const original = fixture();
		const created = buildCompoundFromElements({ scenes: original, hostSceneId: "main", elements: refs });
		const ungrouped = ungroupCompoundElement({
			scenes: created.scenes,
			hostSceneId: "main",
			ref: created.compound,
		});
		expect(layout(getHost(ungrouped.scenes).tracks)).toEqual(layout(getHost(original).tracks));
		// Nested scene is no longer referenced, so it is removed.
		expect(ungrouped.scenes.map((s) => s.id)).toEqual(["main"]);
		expect(ungrouped.elements.map((r) => r.elementId).sort()).toEqual(["box", "music", "title"]);
	});

	test("ungroup of a trimmed compound keeps only the visible part, at the right times", () => {
		const created = buildCompoundFromElements({ scenes: fixture(), hostSceneId: "main", elements: refs });
		const compound = findCompound(created.scenes);
		// Trim 1 s off the start: the compound now starts at 2 s and shows nested 1..4 s.
		const host = getHost(created.scenes);
		const trimmed = created.scenes.map((s) =>
			s.id !== "main"
				? s
				: {
						...s,
						tracks: {
							...host.tracks,
							overlay: host.tracks.overlay.map((tr) => ({
								...tr,
								elements: tr.elements.map((e) =>
									e.id === compound.id
										? { ...e, startTime: t(2), trimStart: t(1), duration: t(3) }
										: e,
								),
							})),
						} as SceneTracks,
					},
		);
		const ungrouped = ungroupCompoundElement({ scenes: trimmed, hostSceneId: "main", ref: created.compound });
		const tracks = getHost(ungrouped.scenes).tracks;
		const byId = new Map(allElements(allTracks(tracks)).map((e) => [e.id, e]));
		// box was 1..5 s → now 2..5 s with 1 s trimmed from its start.
		expect(byId.get("box")?.startTime).toBe(t(2));
		expect(byId.get("box")?.duration).toBe(t(3));
		expect(byId.get("box")?.trimStart).toBe(t(1));
		// title 2..5 s and music 1.5..3.5 s keep their times; music is cut to 2..3.5 s.
		expect(byId.get("title")?.startTime).toBe(t(2));
		expect(byId.get("music")?.startTime).toBe(t(2));
		expect(byId.get("music")?.duration).toBe(t(1.5));
		expect(byId.get("music")?.trimStart).toBe(t(0.5));
	});

	test("audio-only compound goes to an audio track", () => {
		const scenes = fixture();
		const result = buildCompoundFromElements({
			scenes,
			hostSceneId: "main",
			elements: [{ trackId: "t-music", elementId: "music" }],
		});
		expect(getCompoundTrackType({ scenes: result.scenes, sceneId: result.sceneId })).toBe("audio");
		const host = getHost(result.scenes);
		expect(host.tracks.audio).toHaveLength(1);
		expect(host.tracks.audio[0].id).toBe(result.compound.trackId);
		expect(host.tracks.audio[0].elements[0].type).toBe("compound");
	});

	test("nesting depth 2: compound inside compound renders and ungroups", () => {
		const first = buildCompoundFromElements({ scenes: fixture(), hostSceneId: "main", elements: refs });
		const outer = buildCompoundFromElements({
			scenes: first.scenes,
			hostSceneId: "main",
			elements: [first.compound, { trackId: "t-main", elementId: "bg" }],
		});
		const outerScene = outer.scenes.find((s) => s.id === outer.sceneId) as TScene;
		expect(outerScene.tracks.overlay[0].elements[0].type).toBe("compound");
		expect(getCompoundTrackType({ scenes: outer.scenes, sceneId: outer.sceneId })).toBe("video");

		const root = buildScene({
			canvasSize: { width: 1920, height: 1080 },
			tracks: getHost(outer.scenes).tracks,
			mediaAssets: [],
			duration: t(10),
			background: { type: "color", color: "transparent" },
			scenes: outer.scenes,
		});
		const outerNode = root.children.find((n) => n instanceof CompoundNode) as CompoundNode;
		expect(outerNode).toBeDefined();
		const innerNode = outerNode.params.content.children.find((n) => n instanceof CompoundNode) as CompoundNode;
		expect(innerNode).toBeDefined();
		expect(innerNode.params.timeOffset).toBe(t(1));
		expect(innerNode.params.content.children.length).toBe(2); // rectangle + text (audio is not visual)

		const ungrouped = ungroupCompoundElement({ scenes: outer.scenes, hostSceneId: "main", ref: outer.compound });
		expect(findCompound(ungrouped.scenes).sceneId).toBe(first.sceneId);
		expect(getHost(ungrouped.scenes).tracks.main.elements.map((e) => e.id)).toEqual(["bg"]);
	});

	test("cycles are rejected with CompoundCycleError and rendering does not hang", () => {
		const created = buildCompoundFromElements({ scenes: fixture(), hostSceneId: "main", elements: refs });
		// Putting a compound of "main" inside the nested scene would loop main → nested → main.
		expect(() =>
			assertNoCompoundCycle({ scenes: created.scenes, hostSceneId: created.sceneId, sceneId: "main" }),
		).toThrow(CompoundCycleError);
		expect(() =>
			assertNoCompoundCycle({ scenes: created.scenes, hostSceneId: created.sceneId, sceneId: created.sceneId }),
		).toThrow(CompoundCycleError);
		expect(() =>
			assertNoCompoundCycle({ scenes: created.scenes, hostSceneId: "other", sceneId: created.sceneId }),
		).not.toThrow();

		// Force a cycle into the data anyway (e.g. a bad sync): builders and the audio mixer stop.
		const cyclic = created.scenes.map((s) =>
			s.id === created.sceneId
				? {
						...s,
						tracks: {
							...s.tracks,
							overlay: [
								...s.tracks.overlay,
								{
									id: "loop",
									name: "loop",
									type: "video" as const,
									muted: false,
									hidden: false,
									elements: [{ ...findCompound(created.scenes), id: "loop-c", sceneId: s.id }],
								},
							],
						},
					}
				: s,
		);
		const warn = console.warn;
		console.warn = () => {};
		try {
			const root = buildScene({
				canvasSize: { width: 640, height: 360 },
				tracks: getHost(cyclic).tracks,
				mediaAssets: [],
				duration: t(10),
				background: { type: "color", color: "transparent" },
				scenes: cyclic,
			});
			expect(root.children.some((n) => n instanceof CompoundNode)).toBe(true);
			expandCompoundAudioTracks({ tracks: getHost(cyclic).tracks, scenes: cyclic });
		} finally {
			console.warn = warn;
		}
	});

	test("nested audio is offset, trimmed and scaled by the compound volume/muted", () => {
		const created = buildCompoundFromElements({ scenes: fixture(), hostSceneId: "main", elements: refs });
		const withParams = (patch: Partial<CompoundElement>, params: Record<string, number | boolean>) =>
			created.scenes.map((s) =>
				s.id !== "main"
					? s
					: {
							...s,
							tracks: {
								...s.tracks,
								overlay: s.tracks.overlay.map((tr) => ({
									...tr,
									elements: tr.elements.map((e) =>
										e.type === "compound" ? { ...e, ...patch, params: { ...e.params, ...params } } : e,
									),
								})),
							} as SceneTracks,
						},
			);

		// Trim 1 s from the start and lower the volume by 6 dB.
		const scenes = withParams({ startTime: t(2), trimStart: t(1), duration: t(3) }, { volume: -6 });
		const expanded = expandCompoundAudioTracks({ tracks: getHost(scenes).tracks, scenes });
		const nestedAudio = allElements(expanded.audio);
		expect(nestedAudio).toHaveLength(1);
		const music = nestedAudio[0];
		// music sits at nested 0.5..2.5 s; window starts at nested 1 s → parent 2 s, 1.5 s long.
		expect(music.startTime).toBe(t(2));
		expect(music.duration).toBe(t(1.5));
		expect(music.trimStart).toBe(t(0.5));
		expect(music.params.volume).toBe(-6);

		const muted = withParams({}, { muted: true });
		expect(
			expandCompoundAudioTracks({ tracks: getHost(muted).tracks, scenes: muted }).audio,
		).toHaveLength(0);
	});
});
