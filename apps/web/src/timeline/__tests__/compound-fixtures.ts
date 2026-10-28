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
import type { MediaTime } from "@/wasm";

// Shared fixtures for the compound clip tests.

const S = 120_000; // any tick rate works; tests only compare ticks
export const t = (seconds: number) => Math.round(seconds * S) as MediaTime;

function base<T extends TimelineElement["type"]>(
	type: T,
	id: string,
	start: number,
	duration: number,
	params: Record<string, number | string | boolean> = {},
) {
	return {
		id,
		type,
		name: id,
		startTime: t(start),
		duration: t(duration),
		trimStart: t(0),
		trimEnd: t(0),
		params,
	};
}
const text = (id: string, start: number, duration: number) =>
	({ ...base("text", id, start, duration, { content: id }) }) as TextElement;
const rect = (id: string, start: number, duration: number) =>
	({ ...base("graphic", id, start, duration), definitionId: "rectangle" }) as GraphicElement;
const audio = (id: string, start: number, duration: number, volume = 0) =>
	({
		...base("audio", id, start, duration, { volume }),
		sourceType: "upload",
		mediaId: `media-${id}`,
	}) as AudioElement;
const video = (id: string, start: number, duration: number) =>
	({ ...base("video", id, start, duration), mediaId: `media-${id}` }) as VideoElement;

function scene(id: string, tracks: SceneTracks, extra: Partial<TScene> = {}): TScene {
	return {
		id,
		name: id,
		isMain: id === "main",
		tracks,
		bookmarks: [],
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...extra,
	};
}

export function fixture(): TScene[] {
	return [
		scene("main", {
			overlay: [
				{ id: "t-text", name: "Text", type: "text", hidden: false, elements: [text("title", 2, 3)] },
				{ id: "t-gfx", name: "Graphic", type: "graphic", hidden: false, elements: [rect("box", 1, 4)] },
			],
			main: {
				id: "t-main",
				name: "Main Track",
				type: "video",
				muted: false,
				hidden: false,
				elements: [video("bg", 0, 10)],
			},
			audio: [
				{ id: "t-music", name: "Audio", type: "audio", muted: false, elements: [audio("music", 1.5, 2)] },
			],
		}),
	];
}

export const refs = [
	{ trackId: "t-text", elementId: "title" },
	{ trackId: "t-gfx", elementId: "box" },
	{ trackId: "t-music", elementId: "music" },
];

export function allTracks(tracks: SceneTracks): TimelineTrack[] {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

export function allElements(tracks: TimelineTrack[]): TimelineElement[] {
	return tracks.flatMap((track): TimelineElement[] => track.elements);
}

export function layout(tracks: SceneTracks): { id: string; type: string; elements: (string | number)[][] }[] {
	return allTracks(tracks).map((track) => ({
		id: track.id,
		type: track.type,
		elements: allElements([track]).map((e) => [e.id, e.startTime, e.duration, e.trimStart, e.trimEnd]),
	}));
}

export function getHost(scenes: TScene[]) {
	return scenes.find((s) => s.id === "main") as TScene;
}

export function findCompound(scenes: TScene[]): CompoundElement {
	const host = getHost(scenes);
	return allElements(allTracks(host.tracks)).find((e) => e.type === "compound") as CompoundElement;
}

