import type {
	AudioTrack,
	CompoundElement,
	ElementRef,
	OverlayTrack,
	SceneTracks,
	TScene,
	TimelineElement,
	TimelineTrack,
	VideoTrack,
} from "@/timeline";
import { calculateTotalDuration } from "@/timeline";
import { buildDefaultScene } from "@/timeline/scenes";
import { buildEmptyTrack } from "@/timeline/placement/track-factory";
import { canPlaceTimeSpansOnTrack } from "@/timeline/placement/overlap";
import { canElementHaveAudio, isRetimableElement } from "@/timeline/element-utils";
import { canTrackHaveAudio } from "@/timeline/track-capabilities";
import { clampDb, getElementVolume } from "@/timeline/audio-state";
import { splitAnimationsAtTime } from "@/animation";
import type { ElementAnimations, ScalarChannel } from "@/animation/types";
import { getSourceSpanAtClipTime } from "@/retime";
import {
	buildDefaultParamValues,
	getBuiltInElementParams,
} from "@/params/registry";
import { generateUUID } from "@/utils/id";
import { type MediaTime, roundMediaTime, ZERO_MEDIA_TIME } from "@/wasm";

// Compound clips: an element that references a nested scene (kind: "compound").
// All rules (track type, cycles, create/ungroup, audio flattening) live here so the
// timeline UI and the agent path share them.

export class CompoundCycleError extends Error {
	constructor(sceneId: string) {
		super(
			`Compound clip cycle: scene ${sceneId} would contain itself (directly or through nested compound clips)`,
		);
		this.name = "CompoundCycleError";
	}
}

export const DEFAULT_COMPOUND_NAME = "Compound clip";

export function isCompoundScene(scene: TScene): boolean {
	return scene.kind === "compound";
}

/** Scenes the user created (compound content hidden). */
export function getUserScenes({ scenes }: { scenes: TScene[] }): TScene[] {
	return scenes.filter((scene) => !isCompoundScene(scene));
}

export function isCompoundElement(
	element: TimelineElement,
): element is CompoundElement {
	return element.type === "compound";
}

function getOrderedTracks(tracks: SceneTracks): TimelineTrack[] {
	return [...tracks.overlay, tracks.main, ...tracks.audio];
}

function findScene(scenes: TScene[], sceneId: string): TScene | undefined {
	return scenes.find((scene) => scene.id === sceneId);
}

export function getCompoundSceneDuration({
	scenes,
	sceneId,
}: {
	scenes: TScene[];
	sceneId: string;
}): MediaTime {
	const scene = findScene(scenes, sceneId);
	return scene ? calculateTotalDuration({ tracks: scene.tracks }) : ZERO_MEDIA_TIME;
}

function getReferencedSceneIds(tracks: SceneTracks): string[] {
	const ids: string[] = [];
	for (const track of getOrderedTracks(tracks)) {
		for (const element of track.elements) {
			if (isCompoundElement(element)) ids.push(element.sceneId);
		}
	}
	return ids;
}

/** True when `fromSceneId` is `targetSceneId` or contains it through compound clips. */
export function sceneReachesScene({
	scenes,
	fromSceneId,
	targetSceneId,
}: {
	scenes: TScene[];
	fromSceneId: string;
	targetSceneId: string;
}): boolean {
	const visited = new Set<string>();
	const pending = [fromSceneId];
	while (pending.length > 0) {
		const sceneId = pending.pop() as string;
		if (sceneId === targetSceneId) return true;
		if (visited.has(sceneId)) continue;
		visited.add(sceneId);
		const scene = findScene(scenes, sceneId);
		if (scene) pending.push(...getReferencedSceneIds(scene.tracks));
	}
	return false;
}

/** Throws CompoundCycleError if placing a compound of `sceneId` inside `hostSceneId` creates a loop. */
export function assertNoCompoundCycle({
	scenes,
	hostSceneId,
	sceneId,
}: {
	scenes: TScene[];
	hostSceneId: string;
	sceneId: string;
}): void {
	if (sceneReachesScene({ scenes, fromSceneId: sceneId, targetSceneId: hostSceneId })) {
		throw new CompoundCycleError(hostSceneId);
	}
}

/** Visual = anything other than audio (effect layers included); nested compounds recurse. */
export function sceneHasVisualContent({
	scenes,
	sceneId,
	visiting = new Set<string>(),
}: {
	scenes: TScene[];
	sceneId: string;
	visiting?: Set<string>;
}): boolean {
	const scene = findScene(scenes, sceneId);
	if (!scene || visiting.has(sceneId)) return false;
	visiting.add(sceneId);
	return getOrderedTracks(scene.tracks).some((track) =>
		track.elements.some((element) => {
			if (isCompoundElement(element)) {
				return sceneHasVisualContent({
					scenes,
					sceneId: element.sceneId,
					visiting,
				});
			}
			return element.type !== "audio";
		}),
	);
}

/** Track placement rule: any visual content → video track; audio only → audio track. */
export function getCompoundTrackType({
	scenes,
	sceneId,
}: {
	scenes: TScene[];
	sceneId: string;
}): "video" | "audio" {
	return sceneHasVisualContent({ scenes, sceneId }) ? "video" : "audio";
}

export function canCompoundGoOnTrack({
	scenes,
	sceneId,
	trackType,
}: {
	scenes: TScene[];
	sceneId: string;
	trackType: TimelineTrack["type"];
}): boolean {
	return getCompoundTrackType({ scenes, sceneId }) === trackType;
}

/**
 * Cuts an element down to the timeline range [rangeStart, rangeEnd) the same way a split does
 * (trims, retime source spans and keyframes follow). Returns null when nothing is left.
 */
export function clipElementToRange<T extends TimelineElement>({
	element,
	rangeStart,
	rangeEnd,
}: {
	element: T;
	rangeStart: MediaTime;
	rangeEnd: MediaTime;
}): T | null {
	const elementEnd = element.startTime + element.duration;
	const start = Math.max(element.startTime, rangeStart);
	const end = Math.min(elementEnd, rangeEnd);
	if (end <= start) return null;
	if (start === element.startTime && end === elementEnd) return element;

	const retime = isRetimableElement(element) ? element.retime : undefined;
	const sourceSpan = (clipTime: number) =>
		roundMediaTime({ time: getSourceSpanAtClipTime({ clipTime, retime }) });
	const totalSourceSpan = sourceSpan(element.duration);
	const cutLeft = (start - element.startTime) as MediaTime;
	const keptDuration = (end - start) as MediaTime;
	const leftSourceSpan = sourceSpan(cutLeft);
	const keptSourceSpan = sourceSpan(cutLeft + keptDuration) - leftSourceSpan;

	let animations: ElementAnimations | undefined = element.animations;
	if (cutLeft > 0) {
		animations = splitAnimationsAtTime({
			animations,
			splitTime: cutLeft,
			shouldIncludeSplitBoundary: true,
		}).rightAnimations;
	}
	if (end < elementEnd) {
		animations = splitAnimationsAtTime({
			animations,
			splitTime: keptDuration,
			shouldIncludeSplitBoundary: true,
		}).leftAnimations;
	}

	return {
		...element,
		startTime: start as MediaTime,
		duration: keptDuration,
		trimStart: (element.trimStart + leftSourceSpan) as MediaTime,
		trimEnd: (element.trimEnd +
			(totalSourceSpan - leftSourceSpan - keptSourceSpan)) as MediaTime,
		animations,
	};
}

function shiftElement<T extends TimelineElement>(element: T, offset: number): T {
	return { ...element, startTime: (element.startTime + offset) as MediaTime };
}

function removeEmptiedTracks<T extends TimelineTrack>(
	before: T[],
	after: T[],
): T[] {
	return after.filter(
		(track, index) =>
			track.elements.length > 0 || before[index].elements.length === 0,
	);
}

// --- create ---

function countSurvivingTracks(before: TimelineTrack[], after: TimelineTrack[]): number {
	return before.filter((track) => after.some((next) => next.id === track.id)).length;
}

export function buildCompoundFromElements({
	scenes,
	hostSceneId,
	elements,
	name = DEFAULT_COMPOUND_NAME,
}: {
	scenes: TScene[];
	hostSceneId: string;
	elements: ElementRef[];
	name?: string;
}): { scenes: TScene[]; compound: ElementRef; sceneId: string } {
	const host = findScene(scenes, hostSceneId);
	if (!host) throw new Error(`Scene not found: ${hostSceneId}`);
	const tracks = host.tracks;

	const selected = new Set(elements.map((ref) => `${ref.trackId}\u0000${ref.elementId}`));
	const isSelected = (track: TimelineTrack, element: TimelineElement) =>
		selected.has(`${track.id}\u0000${element.id}`);
	const picked = getOrderedTracks(tracks).flatMap((track) =>
		track.elements.filter((element) => isSelected(track, element)),
	);
	if (picked.length === 0) {
		throw new Error("No elements to put in a compound clip");
	}
	if (picked.length !== selected.size) {
		throw new Error("Some selected elements were not found in the scene");
	}

	const minStart = Math.min(...picked.map((element) => element.startTime));
	const maxEnd = Math.max(
		...picked.map((element) => element.startTime + element.duration),
	);
	const duration = (maxEnd - minStart) as MediaTime;

	const without = <T extends TimelineTrack>(track: T): T =>
		({
			...track,
			elements: track.elements.filter((element) => !isSelected(track, element)),
		}) as T;
	const nestedCopy = <T extends TimelineTrack>(track: T, id: string): T =>
		({
			...track,
			id,
			elements: track.elements
				.filter((element) => isSelected(track, element))
				.map((element) => shiftElement(element, -minStart)),
		}) as T;
	// Nested tracks keep the source track id when the source track goes away, so ungroup can restore it.
	const nestedTrackId = (track: TimelineTrack) =>
		track.elements.every((element) => isSelected(track, element))
			? track.id
			: generateUUID();
	const hasPicked = (track: TimelineTrack) =>
		track.elements.some((element) => isSelected(track, element));

	const nestedScene: TScene = {
		...buildDefaultScene({ name, isMain: false }),
		kind: "compound",
	};
	nestedScene.tracks = {
		overlay: tracks.overlay
			.filter(hasPicked)
			.map((track) => nestedCopy(track, nestedTrackId(track))),
		main: {
			...nestedCopy(tracks.main, nestedScene.tracks.main.id),
			name: nestedScene.tracks.main.name,
		},
		audio: tracks.audio
			.filter(hasPicked)
			.map((track) => nestedCopy(track, nestedTrackId(track))),
	};

	const overlayAfter = tracks.overlay.map(without);
	const audioAfter = tracks.audio.map(without);
	const nextTracks: SceneTracks = {
		overlay: removeEmptiedTracks(tracks.overlay, overlayAfter),
		main: without(tracks.main),
		audio: removeEmptiedTracks(tracks.audio, audioAfter),
	};

	const nextScenes = [...scenes, nestedScene];
	const compound: CompoundElement = {
		id: generateUUID(),
		type: "compound",
		name,
		sceneId: nestedScene.id,
		startTime: minStart as MediaTime,
		duration,
		trimStart: ZERO_MEDIA_TIME,
		trimEnd: ZERO_MEDIA_TIME,
		sourceDuration: duration,
		params: buildDefaultParamValues(getBuiltInElementParams({ type: "compound" })),
	};
	const span = [{ startTime: compound.startTime, duration }];
	const trackType = getCompoundTrackType({
		scenes: nextScenes,
		sceneId: nestedScene.id,
	});

	let trackId: string;
	if (trackType === "video") {
		const fromMain = tracks.main.elements.some((element) =>
			isSelected(tracks.main, element),
		);
		const topSourceIndex = tracks.overlay.findIndex(hasPicked);
		const topSource = topSourceIndex >= 0 ? tracks.overlay[topSourceIndex] : null;
		const reusableTop = topSource
			? nextTracks.overlay.find((track) => track.id === topSource.id)
			: undefined;
		if (fromMain && canPlaceTimeSpansOnTrack({ track: nextTracks.main, timeSpans: span })) {
			nextTracks.main = {
				...nextTracks.main,
				elements: [...nextTracks.main.elements, compound],
			};
			trackId = nextTracks.main.id;
		} else if (
			reusableTop?.type === "video" &&
			canPlaceTimeSpansOnTrack({ track: reusableTop, timeSpans: span })
		) {
			nextTracks.overlay = nextTracks.overlay.map((track) =>
				track.id === reusableTop.id
					? { ...reusableTop, elements: [...reusableTop.elements, compound] }
					: track,
			);
			trackId = reusableTop.id;
		} else {
			const insertIndex =
				topSourceIndex >= 0
					? countSurvivingTracks(tracks.overlay.slice(0, topSourceIndex), nextTracks.overlay)
					: nextTracks.overlay.length;
			const track: VideoTrack = {
				...buildEmptyTrack({ id: generateUUID(), type: "video" }),
				elements: [compound],
			};
			nextTracks.overlay = [
				...nextTracks.overlay.slice(0, insertIndex),
				track,
				...nextTracks.overlay.slice(insertIndex),
			];
			trackId = track.id;
		}
	} else {
		const topSourceIndex = tracks.audio.findIndex(hasPicked);
		const topSource = tracks.audio[topSourceIndex];
		const reusableTop = nextTracks.audio.find((track) => track.id === topSource?.id);
		if (reusableTop && canPlaceTimeSpansOnTrack({ track: reusableTop, timeSpans: span })) {
			nextTracks.audio = nextTracks.audio.map((track) =>
				track.id === reusableTop.id
					? { ...reusableTop, elements: [...reusableTop.elements, compound] }
					: track,
			);
			trackId = reusableTop.id;
		} else {
			const insertIndex = countSurvivingTracks(
				tracks.audio.slice(0, Math.max(0, topSourceIndex)),
				nextTracks.audio,
			);
			const track: AudioTrack = {
				...buildEmptyTrack({ id: generateUUID(), type: "audio" }),
				elements: [compound],
			};
			nextTracks.audio = [
				...nextTracks.audio.slice(0, insertIndex),
				track,
				...nextTracks.audio.slice(insertIndex),
			];
			trackId = track.id;
		}
	}

	return {
		scenes: nextScenes.map((scene) =>
			scene.id === hostSceneId
				? { ...scene, tracks: nextTracks, updatedAt: new Date() }
				: scene,
		),
		compound: { trackId, elementId: compound.id },
		sceneId: nestedScene.id,
	};
}

// --- ungroup ---

function isSceneReferenced(scenes: TScene[], sceneId: string): boolean {
	return scenes.some((scene) => getReferencedSceneIds(scene.tracks).includes(sceneId));
}

export function ungroupCompoundElement({
	scenes,
	hostSceneId,
	ref,
}: {
	scenes: TScene[];
	hostSceneId: string;
	ref: ElementRef;
}): { scenes: TScene[]; elements: ElementRef[] } {
	const host = findScene(scenes, hostSceneId);
	if (!host) throw new Error(`Scene not found: ${hostSceneId}`);
	const tracks = host.tracks;
	const sourceTrack = getOrderedTracks(tracks).find((track) => track.id === ref.trackId);
	const compound = sourceTrack?.elements.find((element) => element.id === ref.elementId);
	if (!sourceTrack || !compound || !isCompoundElement(compound)) {
		throw new Error("Compound clip not found");
	}
	const nested = findScene(scenes, compound.sceneId);
	if (!nested) throw new Error(`Compound scene not found: ${compound.sceneId}`);

	const rangeStart = compound.trimStart;
	const rangeEnd = (compound.trimStart + compound.duration) as MediaTime;
	const offset = compound.startTime - compound.trimStart;

	// Drop the compound; its track goes too if that leaves it empty (never the main track).
	const dropCompound = <T extends TimelineTrack>(track: T): T =>
		(track.id === sourceTrack.id
			? { ...track, elements: track.elements.filter((element) => element.id !== compound.id) }
			: track) as T;
	const overlayKept = tracks.overlay.map(dropCompound);
	const audioKept = tracks.audio.map(dropCompound);
	const sourceOverlayIndex = tracks.overlay.findIndex((track) => track.id === sourceTrack.id);
	const sourceAudioIndex = tracks.audio.findIndex((track) => track.id === sourceTrack.id);
	const isEmptiedSource = (track: TimelineTrack) =>
		track.id === sourceTrack.id && track.elements.length === 0;
	const nextTracks: SceneTracks = {
		overlay: overlayKept.filter((track) => !isEmptiedSource(track)),
		main: dropCompound(tracks.main),
		audio: audioKept.filter((track) => !isEmptiedSource(track)),
	};

	const remainingScenes = scenes.map((scene) =>
		scene.id === hostSceneId ? { ...scene, tracks: nextTracks } : scene,
	);
	const keepNested = isSceneReferenced(remainingScenes, nested.id);

	const usedElementIds = new Set(
		getOrderedTracks(nextTracks).flatMap((track) => track.elements.map((e) => e.id)),
	);
	const usedTrackIds = new Set(getOrderedTracks(nextTracks).map((track) => track.id));
	const restored: ElementRef[] = [];

	const restoreElements = <T extends TimelineTrack>(track: T, trackId: string) =>
		track.elements.flatMap((element) => {
			const clipped = clipElementToRange({ element, rangeStart, rangeEnd });
			if (!clipped) return [];
			// Shared content (or an id clash) gets fresh ids so no scene ends up with duplicates.
			const id = keepNested || usedElementIds.has(element.id) ? generateUUID() : element.id;
			usedElementIds.add(id);
			restored.push({ trackId, elementId: id });
			return [{ ...shiftElement(clipped, offset), id }];
		}) as T["elements"];
	const restoreTrack = <T extends TimelineTrack>(track: T): T | null => {
		const id = usedTrackIds.has(track.id) ? generateUUID() : track.id;
		const elements = restoreElements(track, id);
		if (elements.length === 0) return null;
		usedTrackIds.add(id);
		return { ...track, id, elements } as T;
	};

	const newOverlay: OverlayTrack[] = [];
	const nestedMainElements = nested.tracks.main.elements;
	if (nestedMainElements.length > 0) {
		const timeSpans = nestedMainElements
			.map((element) => clipElementToRange({ element, rangeStart, rangeEnd }))
			.filter((element): element is NonNullable<typeof element> => element !== null)
			.map((element) => ({ startTime: (element.startTime + offset) as MediaTime, duration: element.duration }));
		if (canPlaceTimeSpansOnTrack({ track: nextTracks.main, timeSpans })) {
			nextTracks.main = {
				...nextTracks.main,
				elements: [
					...nextTracks.main.elements,
					...restoreElements(nested.tracks.main, nextTracks.main.id),
				],
			};
		} else {
			const track = restoreTrack({
				...buildEmptyTrack({ id: generateUUID(), type: "video" }),
				elements: nested.tracks.main.elements,
			});
			if (track) newOverlay.push(track);
		}
	}
	const overlayFromNested = nested.tracks.overlay
		.map((track) => restoreTrack(track))
		.filter((track): track is OverlayTrack => track !== null);
	newOverlay.unshift(...overlayFromNested);
	const audioFromNested = nested.tracks.audio
		.map((track) => restoreTrack(track))
		.filter((track): track is AudioTrack => track !== null);

	const overlayInsert =
		sourceOverlayIndex >= 0
			? overlayKept
					.slice(0, sourceOverlayIndex)
					.filter((track) => !isEmptiedSource(track)).length
			: nextTracks.overlay.length;
	nextTracks.overlay.splice(overlayInsert, 0, ...newOverlay);
	const audioInsert =
		sourceAudioIndex >= 0
			? audioKept.slice(0, sourceAudioIndex).filter((track) => !isEmptiedSource(track)).length
			: 0;
	nextTracks.audio.splice(audioInsert, 0, ...audioFromNested);

	const nextScenes = scenes
		.filter((scene) => keepNested || scene.id !== nested.id)
		.map((scene) =>
			scene.id === hostSceneId
				? { ...scene, tracks: nextTracks, updatedAt: new Date() }
				: scene,
		);
	return { scenes: nextScenes, elements: restored };
}

// --- audio ---

function shiftVolumeAnimation(
	animations: ElementAnimations | undefined,
	gainDb: number,
): ElementAnimations | undefined {
	const channel = animations?.volume as ScalarChannel | undefined;
	if (!animations || !channel?.keys || gainDb === 0) return animations;
	return {
		...animations,
		volume: {
			...channel,
			keys: channel.keys.map((key) => ({ ...key, value: clampDb(key.value + gainDb) })),
		},
	};
}

/**
 * Returns `tracks` plus virtual tracks holding the audio of every compound clip (recursively):
 * nested audio/video elements cut to the compound's trim window, moved to parent time, with the
 * compound's volume added (dB) and its mute applied. Only the audio mixers read these tracks.
 */
export function expandCompoundAudioTracks({
	tracks,
	scenes,
	stack = [],
}: {
	tracks: SceneTracks;
	scenes: TScene[];
	stack?: string[];
}): SceneTracks {
	const extraOverlay: VideoTrack[] = [];
	const extraAudio: AudioTrack[] = [];

	for (const track of getOrderedTracks(tracks)) {
		if (canTrackHaveAudio(track) && track.muted) continue;
		for (const compound of track.elements) {
			if (!isCompoundElement(compound) || compound.params.muted === true) continue;
			const nested = findScene(scenes, compound.sceneId);
			if (!nested) continue;
			if (stack.includes(nested.id)) {
				console.warn(new CompoundCycleError(nested.id).message);
				continue;
			}
			const nestedTracks = expandCompoundAudioTracks({
				tracks: nested.tracks,
				scenes,
				stack: [...stack, nested.id],
			});
			const gainDb = typeof compound.params.volume === "number" ? compound.params.volume : 0;
			const offset = compound.startTime - compound.trimStart;
			const rangeEnd = (compound.trimStart + compound.duration) as MediaTime;

			for (const nestedTrack of getOrderedTracks(nestedTracks)) {
				if (!canTrackHaveAudio(nestedTrack) || nestedTrack.muted) continue;
				const elements = nestedTrack.elements.flatMap((element) => {
					if (!canElementHaveAudio(element)) return [];
					const clipped = clipElementToRange({
						element,
						rangeStart: compound.trimStart,
						rangeEnd,
					});
					if (!clipped) return [];
					return [
						{
							...shiftElement(clipped, offset),
							// Unique per compound instance: one nested scene can be used by several clips.
							id: `${compound.id}/${element.id}`,
							params: {
								...clipped.params,
								volume: clampDb(getElementVolume({ element: clipped }) + gainDb),
							},
							animations: shiftVolumeAnimation(clipped.animations, gainDb),
						},
					];
				});
				if (elements.length === 0) continue;
				const id = `${compound.id}/${nestedTrack.id}`;
				if (nestedTrack.type === "audio") {
					extraAudio.push({ ...nestedTrack, id, elements: elements as AudioTrack["elements"] });
				} else {
					extraOverlay.push({ ...nestedTrack, id, elements: elements as VideoTrack["elements"] });
				}
			}
		}
	}

	if (extraOverlay.length === 0 && extraAudio.length === 0) return tracks;
	return {
		overlay: [...tracks.overlay, ...extraOverlay],
		main: tracks.main,
		audio: [...tracks.audio, ...extraAudio],
	};
}
