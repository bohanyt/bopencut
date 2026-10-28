import { describe, expect, test } from "bun:test";
import type {
	AudioElement,
	CompoundElement,
	SceneTracks,
	TScene,
} from "@/timeline";
import {
	buildCompoundFromElements,
	expandCompoundAudioTracks,
	syncCompoundDurations,
	ungroupCompoundElement,
} from "@/timeline/compound";
import {
	getTrackTypeForElement,
	validateElementTrackCompatibility,
} from "@/timeline/placement/compatibility";
import { resolveEffectiveAudioGain } from "@/timeline/audio-state";
import { buildScene } from "@/services/renderer/scene-builder";
import { CompoundNode } from "@/services/renderer/nodes/compound-node";
import { TextNode } from "@/services/renderer/nodes/text-node";
import { BlurBackgroundNode } from "@/services/renderer/nodes/blur-background-node";
import type { MediaAsset } from "@/media/types";
import {
	allElements,
	allTracks,
	audio,
	findCompound,
	fixture,
	getHost,
	layout,
	rect,
	refs,
	scene,
	t,
	text,
	video,
} from "./compound-fixtures";

// Regression tests for the compound clip rules (track reuse, ungroup layout, durations,
// gain, placement, blurred background).

function withCompound(
	scenes: TScene[],
	sceneId: string,
	patch: (element: CompoundElement) => CompoundElement,
): TScene[] {
	return scenes.map((s) => {
		if (s.id !== sceneId) return s;
		const mapTrack = <T extends SceneTracks["overlay"][number] | SceneTracks["main"] | SceneTracks["audio"][number]>(
			track: T,
		): T =>
			({
				...track,
				elements: track.elements.map((e) => (e.type === "compound" ? patch(e) : e)),
			}) as T;
		return {
			...s,
			tracks: {
				overlay: s.tracks.overlay.map(mapTrack),
				main: mapTrack(s.tracks.main),
				audio: s.tracks.audio.map(mapTrack),
			},
		};
	});
}

function audioOnlyTracks(elements: (AudioElement | CompoundElement)[]): SceneTracks {
	return {
		overlay: [],
		main: { id: "m", name: "Main Track", type: "video", muted: false, hidden: false, elements: [] },
		audio: [{ id: "a", name: "Audio", type: "audio", muted: false, elements }],
	};
}

function compoundEl(
	id: string,
	sceneId: string,
	start: number,
	duration: number,
	volume: number,
): CompoundElement {
	return {
		id,
		type: "compound",
		name: id,
		sceneId,
		startTime: t(start),
		duration: t(duration),
		trimStart: t(0),
		trimEnd: t(0),
		sourceDuration: t(duration),
		params: { volume, muted: false },
	};
}

describe("compound clip rules", () => {
	test("grouping never lands on a muted main track (music stays audible)", () => {
		const scenes = fixture();
		const host = getHost(scenes);
		host.tracks.main = { ...host.tracks.main, muted: true };
		const result = buildCompoundFromElements({
			scenes,
			hostSceneId: "main",
			elements: [
				{ trackId: "t-main", elementId: "bg" },
				{ trackId: "t-music", elementId: "music" },
			],
		});
		const after = getHost(result.scenes);
		expect(result.compound.trackId).not.toBe("t-main");
		const compoundTrack = allTracks(after.tracks).find((tr) => tr.id === result.compound.trackId);
		expect(compoundTrack).toMatchObject({ type: "video", muted: false, hidden: false });
		// The muted main track's flag travels with its nested copy; the music track's does not.
		const nested = result.scenes.find((s) => s.id === result.sceneId) as TScene;
		expect(nested.tracks.main.muted).toBe(true);
		const expanded = expandCompoundAudioTracks({ tracks: after.tracks, scenes: result.scenes });
		expect(allElements(expanded.audio).map((e) => e.id)).toEqual([
			`${result.compound.elementId}/music`,
		]);
	});

	test("grouping never lands on a hidden track (visible children stay visible)", () => {
		const scenes = fixture();
		const host = getHost(scenes);
		host.tracks.overlay = [
			{
				id: "t-hidden",
				name: "Hidden",
				type: "video",
				muted: false,
				hidden: true,
				elements: [video("a", 0, 2), video("b", 5, 1)],
			},
			...host.tracks.overlay,
		];
		const grouped = buildCompoundFromElements({
			scenes,
			hostSceneId: "main",
			elements: [
				{ trackId: "t-hidden", elementId: "a" },
				{ trackId: "t-text", elementId: "title" },
			],
		});
		expect(grouped.compound.trackId).not.toBe("t-hidden");
		const root = buildScene({
			canvasSize: { width: 640, height: 360 },
			tracks: getHost(grouped.scenes).tracks,
			mediaAssets: [],
			duration: t(10),
			background: { type: "color", color: "transparent" },
			scenes: grouped.scenes,
		});
		const node = root.children.find((n) => n instanceof CompoundNode) as CompoundNode;
		expect(node.params.content.children.some((n) => n instanceof TextNode)).toBe(true);
	});

	test("ungroup restores interleaved tracks and partial-track selections to their original tracks", () => {
		const scenes = fixture();
		getHost(scenes).tracks.overlay = [
			{ id: "A", name: "A", type: "text", hidden: false, elements: [text("a1", 0, 2)] },
			{ id: "B", name: "B", type: "graphic", hidden: false, elements: [rect("b1", 0, 2)] },
			{ id: "C", name: "C", type: "text", hidden: false, elements: [text("c1", 1, 2), text("c2", 6, 1)] },
		];
		const original = structuredClone(scenes);
		const created = buildCompoundFromElements({
			scenes,
			hostSceneId: "main",
			elements: [
				{ trackId: "A", elementId: "a1" },
				{ trackId: "C", elementId: "c1" },
			],
		});
		// C keeps c2, so it survives; A is emptied and removed.
		expect(getHost(created.scenes).tracks.overlay.map((tr) => tr.id)).toEqual([
			created.compound.trackId,
			"B",
			"C",
		]);
		const ungrouped = ungroupCompoundElement({
			scenes: created.scenes,
			hostSceneId: "main",
			ref: created.compound,
		});
		const sorted = (tracks: SceneTracks) =>
			layout(tracks).map((tr) => ({ ...tr, elements: [...tr.elements].sort() }));
		expect(sorted(getHost(ungrouped.scenes).tracks)).toEqual(sorted(getHost(original).tracks));
	});

	test("sourceDuration follows the nested scene for every reference, including outer compounds", () => {
		const created = buildCompoundFromElements({ scenes: fixture(), hostSceneId: "main", elements: refs });
		const first = findCompound(created.scenes);
		// A second reference to the same nested scene (like a split half), on its own track.
		const shared: CompoundElement = { ...first, id: "shared", startTime: t(20), duration: t(2) };
		let scenes = created.scenes.map((s) =>
			s.id === "main"
				? {
						...s,
						tracks: {
							...s.tracks,
							overlay: [
								...s.tracks.overlay,
								{
									id: "t-shared",
									name: "S",
									type: "video" as const,
									muted: false,
									hidden: false,
									elements: [shared],
								},
							],
						},
					}
				: s,
		);
		// Extend the box inside the nested scene from 4 s to 8 s.
		scenes = scenes.map((s) =>
			s.id === created.sceneId
				? {
						...s,
						tracks: {
							...s.tracks,
							overlay: s.tracks.overlay.map((tr) => ({
								...tr,
								elements: tr.elements.map((e) => (e.id === "box" ? { ...e, duration: t(8) } : e)),
							})) as SceneTracks["overlay"],
						},
					}
				: s,
		);
		const synced = syncCompoundDurations(scenes);
		const compounds = allElements(allTracks(getHost(synced).tracks)).filter(
			(e): e is CompoundElement => e.type === "compound",
		);
		// Span unchanged; the extra material becomes trimEnd so the clip can be extended.
		expect(compounds.map((c) => [c.id, c.sourceDuration, c.duration, c.trimEnd])).toEqual([
			[first.id, t(8), t(4), t(4)],
			["shared", t(8), t(2), t(6)],
		]);
		expect(syncCompoundDurations(synced)).toBe(synced);

		// Outer compound: lengthening the inner clip inside the outer scene updates the outer clip.
		const outer = buildCompoundFromElements({
			scenes: synced,
			hostSceneId: "main",
			elements: [created.compound],
		});
		const longer = withCompound(outer.scenes, outer.sceneId, (e) => ({ ...e, duration: t(6) }));
		const outerClip = allElements(allTracks(getHost(syncCompoundDurations(longer)).tracks)).find(
			(e) => e.id === outer.compound.elementId,
		) as CompoundElement;
		expect([outerClip.sourceDuration, outerClip.duration, outerClip.trimEnd]).toEqual([
			t(6),
			t(4),
			t(2),
		]);
	});

	test("nested gains add up without clamping at each level (-40 + -40 + 20 = -60 dB)", () => {
		const inner = scene("inner", audioOnlyTracks([audio("tone", 0, 2, -40)]), { kind: "compound" });
		const middle = scene("middle", audioOnlyTracks([compoundEl("c-inner", "inner", 0, 2, -40)]), {
			kind: "compound",
		});
		const host = scene("main", audioOnlyTracks([compoundEl("c-middle", "middle", 1, 2, 20)]));
		const expanded = expandCompoundAudioTracks({ tracks: host.tracks, scenes: [host, middle, inner] });
		const tone = allElements(expanded.audio).find((e) => e.id.endsWith("/tone")) as AudioElement;
		expect(tone.params.volume).toBe(-60);
		expect(tone.startTime).toBe(t(1));
		expect(resolveEffectiveAudioGain({ element: tone, localTime: 0 })).toBeCloseTo(0.001, 6);
	});

	test("ungroup folds the compound's volume and mute into audio-bearing children", () => {
		const created = buildCompoundFromElements({
			scenes: fixture(),
			hostSceneId: "main",
			elements: [...refs, { trackId: "t-main", elementId: "bg" }],
		});
		const scenes = withCompound(created.scenes, "main", (e) => ({
			...e,
			params: { ...e.params, volume: -12, muted: true },
		}));
		const ungrouped = ungroupCompoundElement({ scenes, hostSceneId: "main", ref: created.compound });
		const byId = new Map(
			allElements(allTracks(getHost(ungrouped.scenes).tracks)).map((e) => [e.id, e]),
		);
		expect(byId.get("music")?.params).toMatchObject({ volume: -12, muted: true });
		expect(byId.get("bg")?.params).toMatchObject({ volume: -12, muted: true });
		// Visual-only children are untouched.
		expect(byId.get("title")?.params.volume).toBeUndefined();

		// A nested compound child takes the gain too, so the total stays the same.
		const first = buildCompoundFromElements({ scenes: fixture(), hostSceneId: "main", elements: refs });
		const outer = buildCompoundFromElements({
			scenes: first.scenes,
			hostSceneId: "main",
			elements: [first.compound],
		});
		const quieter = withCompound(outer.scenes, "main", (e) => ({
			...e,
			params: { ...e.params, volume: -9 },
		}));
		const back = ungroupCompoundElement({ scenes: quieter, hostSceneId: "main", ref: outer.compound });
		expect(findCompound(back.scenes).params.volume).toBe(-9);
	});

	test("track compatibility uses the content rule for compound clips", () => {
		const created = buildCompoundFromElements({ scenes: fixture(), hostSceneId: "main", elements: refs });
		const visual = findCompound(created.scenes);
		const audioOnly = buildCompoundFromElements({
			scenes: fixture(),
			hostSceneId: "main",
			elements: [{ trackId: "t-music", elementId: "music" }],
		});
		const audioClip = findCompound(audioOnly.scenes);
		const valid = (element: CompoundElement, type: "audio" | "video", scenes: TScene[]) =>
			validateElementTrackCompatibility({ element, track: { type }, scenes }).isValid;
		expect(valid(visual, "audio", created.scenes)).toBe(false);
		expect(valid(visual, "video", created.scenes)).toBe(true);
		expect(valid(audioClip, "audio", audioOnly.scenes)).toBe(true);
		// Policy: a compound may always stay on a video track (its audio still plays there).
		expect(valid(audioClip, "video", audioOnly.scenes)).toBe(true);
		expect(getTrackTypeForElement({ element: audioClip, scenes: audioOnly.scenes })).toBe("audio");
		expect(getTrackTypeForElement({ element: visual, scenes: created.scenes })).toBe("video");
	});

	test("a compound on the main track keeps the blurred background, mapped to nested time", () => {
		const created = buildCompoundFromElements({
			scenes: fixture(),
			hostSceneId: "main",
			elements: [{ trackId: "t-main", elementId: "bg" }],
		});
		expect(getHost(created.scenes).tracks.main.elements[0].type).toBe("compound");
		// Trim 2 s off the compound's start: it shows bg 2..10 s at parent 2..10 s.
		const scenes = withCompound(created.scenes, "main", (e) => ({
			...e,
			startTime: t(2),
			trimStart: t(2),
			duration: t(8),
		}));
		const root = buildScene({
			canvasSize: { width: 640, height: 360 },
			tracks: getHost(scenes).tracks,
			mediaAssets: [
				{
					id: "media-bg",
					name: "bg",
					type: "video",
					file: new File([], "bg.mp4"),
					url: "blob:bg",
				} as MediaAsset,
			],
			duration: t(10),
			background: { type: "blur", blurIntensity: 20 },
			scenes,
		});
		const blur = root.children.filter((n): n is BlurBackgroundNode => n instanceof BlurBackgroundNode);
		expect(
			blur.map((n) => [n.params.mediaId, n.params.timeOffset, n.params.duration, n.params.trimStart]),
		).toEqual([["media-bg", t(2), t(8), t(2)]]);
	});
});
