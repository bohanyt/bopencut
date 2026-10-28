import { describe, expect, test } from "bun:test";
import type {
	AudioTrack,
	CompoundElement,
	SceneTracks,
	TScene,
	TextTrack,
	TimelineTrack,
} from "@/timeline";
import {
	assertTracksAcyclic,
	buildCompoundFromElements,
	relocateVisualCompounds,
	ungroupCompoundElement,
} from "@/timeline/compound";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { getElementParam } from "@/params/registry";
import {
	allTracks,
	audio,
	findCompound,
	fixture,
	getHost,
	rect,
	scene,
	t,
	text,
} from "./compound-fixtures";

// Regression tests for the compound content-change policy, ungroup track state,
// cycle-check cost and compound volume automation.

function setTrackFlags(
	scenes: TScene[],
	sceneId: string,
	match: (track: TimelineTrack) => boolean,
	flags: { muted?: boolean; hidden?: boolean },
): TScene[] {
	return scenes.map((s) => {
		if (s.id !== sceneId) return s;
		const apply = <T extends TimelineTrack>(track: T): T =>
			(match(track) ? { ...track, ...flags } : track) as T;
		return {
			...s,
			tracks: {
				overlay: s.tracks.overlay.map(apply),
				main: apply(s.tracks.main),
				audio: s.tracks.audio.map(apply),
			},
		};
	});
}

/** Host with an audio track holding two clips and a text track holding two titles. */
function sharedTrackFixture(): TScene[] {
	const scenes = fixture();
	const host = getHost(scenes);
	host.tracks.audio = [
		{
			id: "t-music",
			name: "Audio",
			type: "audio",
			muted: false,
			elements: [audio("music", 1.5, 2), audio("stay", 10, 2)],
		},
	];
	host.tracks.overlay = [
		{
			id: "t-text",
			name: "Text",
			type: "text",
			hidden: false,
			elements: [text("title", 2, 3), text("other", 10, 2)],
		},
		...host.tracks.overlay.filter((track) => track.id !== "t-text"),
	];
	return scenes;
}

function ungroupAfter(change: (created: ReturnType<typeof buildCompoundFromElements>) => TScene[]) {
	const created = buildCompoundFromElements({
		scenes: sharedTrackFixture(),
		hostSceneId: "main",
		elements: [
			{ trackId: "t-music", elementId: "music" },
			{ trackId: "t-text", elementId: "title" },
		],
	});
	const scenes = change(created);
	const result = ungroupCompoundElement({ scenes, hostSceneId: "main", ref: created.compound });
	const tracks = allTracks(getHost(result.scenes).tracks);
	const trackOf = (elementId: string) =>
		tracks.find((track) => track.elements.some((element) => element.id === elementId)) as
			| AudioTrack
			| TextTrack;
	return { trackOf };
}

describe("compound clip policy", () => {
	test("ungroup does not merge a muted/hidden nested track into the unmuted/visible original", () => {
		const { trackOf } = ungroupAfter((created) =>
			setTrackFlags(
				created.scenes,
				created.sceneId,
				(track) => track.type === "audio" || track.type === "text",
				{ muted: true, hidden: true },
			),
		);
		const music = trackOf("music") as AudioTrack;
		expect(music.id).not.toBe("t-music");
		expect(music.muted).toBe(true);
		expect((trackOf("stay") as AudioTrack).muted).toBe(false);
		const title = trackOf("title") as TextTrack;
		expect(title.id).not.toBe("t-text");
		expect(title.hidden).toBe(true);
		expect((trackOf("other") as TextTrack).hidden).toBe(false);
	});

	test("ungroup does not merge into an original track that was muted/hidden meanwhile", () => {
		const { trackOf } = ungroupAfter((created) =>
			setTrackFlags(created.scenes, "main", (track) => track.id === "t-music" || track.id === "t-text", {
				muted: true,
				hidden: true,
			}),
		);
		const music = trackOf("music") as AudioTrack;
		expect(music.id).not.toBe("t-music");
		expect(music.muted).toBe(false);
		const title = trackOf("title") as TextTrack;
		expect(title.id).not.toBe("t-text");
		expect(title.hidden).toBe(false);
		// Matching flags still merge back onto the original track.
		const plain = ungroupAfter((created) => created.scenes);
		expect(plain.trackOf("music").id).toBe("t-music");
		expect(plain.trackOf("title").id).toBe("t-text");
	});

	test("an audio-only compound that gains visuals moves to a video track (same mute, deterministic)", () => {
		const created = buildCompoundFromElements({
			scenes: fixture(),
			hostSceneId: "main",
			elements: [{ trackId: "t-music", elementId: "music" }],
		});
		const muted = setTrackFlags(created.scenes, "main", (track) => track.id === created.compound.trackId, {
			muted: true,
		});
		expect(relocateVisualCompounds(muted)).toBe(muted);

		const withVisual = muted.map((s) =>
			s.id === created.sceneId
				? {
						...s,
						tracks: {
							...s.tracks,
							overlay: [
								{ id: "g", name: "G", type: "graphic" as const, hidden: false, elements: [rect("new-box", 0, 1)] },
							],
						},
					}
				: s,
		);
		const relocated = relocateVisualCompounds(withVisual);
		const host = getHost(relocated);
		const clip = findCompound(relocated);
		expect(host.tracks.audio.some((track) => track.elements.some((e) => e.id === clip.id))).toBe(false);
		const videoTrack = host.tracks.overlay.find((track) => track.elements.some((e) => e.id === clip.id));
		expect(videoTrack).toMatchObject({ type: "video", muted: true, hidden: false });
		// The emptied audio track is removed; the result is the same on every run (redo-safe ids).
		expect(host.tracks.audio.some((track) => track.id === created.compound.trackId)).toBe(false);
		expect(getHost(relocateVisualCompounds(withVisual)).tracks.overlay.map((track) => track.id)).toEqual(
			host.tracks.overlay.map((track) => track.id),
		);
	});

	test("cycle validation reads each referenced scene once, however many clips point at it", () => {
		const bigElements = Array.from({ length: 20_000 }, (_, index) => text(`e${index}`, index, 1));
		let iterations = 0;
		const counted = new Proxy(bigElements, {
			get(target, key, receiver) {
				if (key === Symbol.iterator) iterations++;
				return Reflect.get(target, key, receiver);
			},
		});
		const big = scene(
			"big",
			{
				overlay: [{ id: "big-t", name: "T", type: "text", hidden: false, elements: counted }],
				main: { id: "big-m", name: "Main Track", type: "video", muted: false, hidden: false, elements: [] },
				audio: [],
			},
			{ kind: "compound" },
		);
		const clips: CompoundElement[] = Array.from({ length: 1000 }, (_, index) => ({
			id: `c${index}`,
			type: "compound",
			name: "c",
			sceneId: "big",
			startTime: t(index * 2),
			duration: t(1),
			trimStart: t(0),
			trimEnd: t(0),
			params: {},
		}));
		const tracks: SceneTracks = {
			overlay: [{ id: "v", name: "V", type: "video", muted: false, hidden: false, elements: clips }],
			main: { id: "m", name: "Main Track", type: "video", muted: false, hidden: false, elements: [] },
			audio: [],
		};
		const host = scene("main", tracks);
		assertTracksAcyclic({ scenes: [host, big], sceneId: "main", tracks });
		expect(iterations).toBe(1);
	});

	test("compound volume cannot be keyframed (single gain for now)", () => {
		const created = buildCompoundFromElements({ scenes: fixture(), hostSceneId: "main", elements: [{ trackId: "t-music", elementId: "music" }] });
		const clip = findCompound(created.scenes);
		expect(getElementParam({ element: clip, key: "volume" })?.keyframable).toBe(false);
		expect(resolveAnimationTarget({ element: clip, path: "volume" })).toBeNull();
		expect(resolveAnimationTarget({ element: clip, path: "opacity" })).not.toBeNull();
	});

	test("relocation checks a nested scene's content once, however many clips use it", () => {
		const bigElements = Array.from({ length: 20_000 }, (_, index) => audio(`a${index}`, index, 1));
		let scans = 0;
		const counted = new Proxy(bigElements, {
			get(target, key, receiver) {
				if (key === "some") scans++;
				return Reflect.get(target, key, receiver);
			},
		});
		const big = scene(
			"big",
			{
				overlay: [],
				main: { id: "big-m", name: "Main Track", type: "video", muted: false, hidden: false, elements: [] },
				audio: [{ id: "big-a", name: "A", type: "audio", muted: false, elements: counted }],
			},
			{ kind: "compound" },
		);
		const clips: CompoundElement[] = Array.from({ length: 1000 }, (_, index) => ({
			id: `c${index}`,
			type: "compound",
			name: "c",
			sceneId: "big",
			startTime: t(index * 2),
			duration: t(1),
			trimStart: t(0),
			trimEnd: t(0),
			params: {},
		}));
		const host = scene("main", {
			overlay: [],
			main: { id: "m", name: "Main Track", type: "video", muted: false, hidden: false, elements: [] },
			audio: [{ id: "a", name: "A", type: "audio", muted: false, elements: clips }],
		});
		const scenes = [host, big];
		expect(relocateVisualCompounds(scenes)).toBe(scenes);
		expect(scans).toBe(1);
	});
});
