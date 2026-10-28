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

function isTrackHidden(track: TimelineTrack): boolean {
	return "hidden" in track && track.hidden === true;
}

/**
 * A host track the compound can sit on without changing how its content looks or sounds.
 * The selected elements' own track flags travel with their nested tracks, so only a
 * plain (unmuted, visible) track is safe to reuse.
 */
function isNeutralTrack(track: TimelineTrack): boolean {
	return !(canTrackHaveAudio(track) && track.muted) && !isTrackHidden(track);
}

function findTrackIn(tracks: SceneTracks, trackId: string): TimelineTrack | undefined {
	return getOrderedTracks(tracks).find((track) => track.id === trackId);
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
	const hasPicked = (track: TimelineTrack) =>
		track.elements.some((element) => isSelected(track, element));

	// Nested tracks get fresh ids; compoundOrigin remembers which host track each came from.
	const trackSources: Record<string, string> = {};
	const nestedCopy = <T extends TimelineTrack>(track: T, id = generateUUID()): T => {
		trackSources[id] = track.id;
		return {
			...track,
			id,
			elements: track.elements
				.filter((element) => isSelected(track, element))
				.map((element) => shiftElement(element, -minStart)),
		} as T;
	};

	const nestedScene: TScene = {
		...buildDefaultScene({ name, isMain: false }),
		kind: "compound",
	};
	nestedScene.tracks = {
		overlay: tracks.overlay.filter(hasPicked).map((track) => nestedCopy(track)),
		main: {
			...nestedCopy(tracks.main, nestedScene.tracks.main.id),
			name: nestedScene.tracks.main.name,
		},
		audio: tracks.audio.filter(hasPicked).map((track) => nestedCopy(track)),
	};
	nestedScene.compoundOrigin = {
		hostTrackOrder: getOrderedTracks(tracks).map((track) => track.id),
		trackSources,
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
	const canHost = (track: TimelineTrack | undefined): track is TimelineTrack =>
		track !== undefined &&
		isNeutralTrack(track) &&
		canPlaceTimeSpansOnTrack({ track, timeSpans: span });
	const trackType = getCompoundTrackType({
		scenes: nextScenes,
		sceneId: nestedScene.id,
	});

	let trackId: string;
	if (trackType === "video") {
		const fromMain = hasPicked(tracks.main);
		const topSourceIndex = tracks.overlay.findIndex(hasPicked);
		const topSource = topSourceIndex >= 0 ? tracks.overlay[topSourceIndex] : null;
		const reusableTop = topSource
			? nextTracks.overlay.find((track) => track.id === topSource.id)
			: undefined;
		if (fromMain && canHost(nextTracks.main)) {
			nextTracks.main = {
				...nextTracks.main,
				elements: [...nextTracks.main.elements, compound],
			};
			trackId = nextTracks.main.id;
		} else if (reusableTop?.type === "video" && canHost(reusableTop)) {
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
		if (canHost(reusableTop)) {
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

/** True while some compound clip still points at the scene (it must not be deleted then). */
export function isCompoundSceneReferenced({
	scenes,
	sceneId,
}: {
	scenes: TScene[];
	sceneId: string;
}): boolean {
	return scenes.some((scene) => getReferencedSceneIds(scene.tracks).includes(sceneId));
}

function readVolumeDb(element: TimelineElement): number {
	return typeof element.params.volume === "number" ? element.params.volume : 0;
}

/**
 * Applies a compound's volume (dB, not clamped so nested gains add up exactly) and mute to an
 * audio-bearing element: audio, video (source audio) or a nested compound.
 */
function foldCompoundAudio<T extends TimelineElement>({
	element,
	gainDb,
	muted,
}: {
	element: T;
	gainDb: number;
	muted: boolean;
}): T {
	if (!canElementHaveAudio(element) && !isCompoundElement(element)) return element;
	if (gainDb === 0 && !muted) return element;
	return {
		...element,
		params: {
			...element.params,
			volume: readVolumeDb(element) + gainDb,
			muted: element.params.muted === true || muted,
		},
		animations: shiftVolumeAnimation(element.animations, gainDb),
	};
}

/** Index in `section` next to the nearest original neighbour of `sourceTrackId`, if one survives. */
function findOriginalPosition(
	section: TimelineTrack[],
	order: string[],
	sourceTrackId: string | undefined,
): number | null {
	const index = sourceTrackId ? order.indexOf(sourceTrackId) : -1;
	if (index < 0) return null;
	for (let j = index - 1; j >= 0; j--) {
		const at = section.findIndex((track) => track.id === order[j]);
		if (at >= 0) return at + 1;
	}
	for (let j = index + 1; j < order.length; j++) {
		const at = section.findIndex((track) => track.id === order[j]);
		if (at >= 0) return at;
	}
	return null;
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
	const sourceTrack = findTrackIn(tracks, ref.trackId);
	const compound = sourceTrack?.elements.find((element) => element.id === ref.elementId);
	if (!sourceTrack || !compound || !isCompoundElement(compound)) {
		throw new Error("Compound clip not found");
	}
	const nested = findScene(scenes, compound.sceneId);
	if (!nested) throw new Error(`Compound scene not found: ${compound.sceneId}`);

	const rangeStart = compound.trimStart;
	const rangeEnd = (compound.trimStart + compound.duration) as MediaTime;
	const offset = compound.startTime - compound.trimStart;
	const gainDb = readVolumeDb(compound);
	const muted = compound.params.muted === true;

	// Drop the compound; its track goes too if that leaves it empty (never the main track).
	const dropCompound = <T extends TimelineTrack>(track: T): T =>
		(track.id === sourceTrack.id
			? { ...track, elements: track.elements.filter((element) => element.id !== compound.id) }
			: track) as T;
	const keep = (track: TimelineTrack) =>
		track.id !== sourceTrack.id || track.elements.length > 0;
	const overlayKept = tracks.overlay.map(dropCompound);
	const audioKept = tracks.audio.map(dropCompound);
	const nextTracks: SceneTracks = {
		overlay: overlayKept.filter(keep),
		main: dropCompound(tracks.main),
		audio: audioKept.filter(keep),
	};
	// Where the compound's own track was: the fallback for tracks without a surviving neighbour.
	const sourceOverlayIndex = tracks.overlay.findIndex((track) => track.id === sourceTrack.id);
	const sourceAudioIndex = tracks.audio.findIndex((track) => track.id === sourceTrack.id);
	let overlayFallback =
		sourceOverlayIndex >= 0
			? overlayKept.slice(0, sourceOverlayIndex).filter(keep).length
			: nextTracks.overlay.length;
	let audioFallback =
		sourceAudioIndex >= 0 ? audioKept.slice(0, sourceAudioIndex).filter(keep).length : 0;

	const remainingScenes = scenes.map((scene) =>
		scene.id === hostSceneId ? { ...scene, tracks: nextTracks } : scene,
	);
	const keepNested = isCompoundSceneReferenced({ scenes: remainingScenes, sceneId: nested.id });
	const order = nested.compoundOrigin?.hostTrackOrder ?? [];
	const trackSources = nested.compoundOrigin?.trackSources ?? {};

	const usedElementIds = new Set(
		getOrderedTracks(nextTracks).flatMap((track) => track.elements.map((e) => e.id)),
	);
	const usedTrackIds = new Set(getOrderedTracks(nextTracks).map((track) => track.id));
	const restored: ElementRef[] = [];

	const prepareElements = (track: TimelineTrack): TimelineElement[] =>
		track.elements.flatMap((element) => {
			const clipped = clipElementToRange({ element, rangeStart, rangeEnd });
			if (!clipped) return [];
			// Shared content (or an id clash) gets fresh ids so no scene ends up with duplicates.
			const id = keepNested || usedElementIds.has(element.id) ? generateUUID() : element.id;
			usedElementIds.add(id);
			return [foldCompoundAudio({ element: { ...shiftElement(clipped, offset), id }, gainDb, muted })];
		});
	const mergeInto = (target: TimelineTrack, elements: TimelineElement[]) => {
		const merged = { ...target, elements: [...target.elements, ...elements] } as TimelineTrack;
		if (merged.id === nextTracks.main.id) nextTracks.main = merged as VideoTrack;
		else if (merged.type === "audio")
			nextTracks.audio = nextTracks.audio.map((track) => (track.id === merged.id ? merged : track)) as AudioTrack[];
		else
			nextTracks.overlay = nextTracks.overlay.map((track) => (track.id === merged.id ? merged : track)) as OverlayTrack[];
		for (const element of elements) restored.push({ trackId: merged.id, elementId: element.id });
	};

	for (const nestedTrack of getOrderedTracks(nested.tracks)) {
		const elements = prepareElements(nestedTrack);
		if (elements.length === 0) continue;
		const isNestedMain = nestedTrack.id === nested.tracks.main.id;
		const sourceTrackId =
			trackSources[nestedTrack.id] ?? (isNestedMain ? nextTracks.main.id : undefined);
		const timeSpans = elements.map((element) => ({
			startTime: element.startTime,
			duration: element.duration,
		}));

		// Back onto the original track when it still exists and has room.
		const survivor = sourceTrackId ? findTrackIn(nextTracks, sourceTrackId) : undefined;
		if (
			survivor &&
			survivor.type === nestedTrack.type &&
			canPlaceTimeSpansOnTrack({ track: survivor, timeSpans })
		) {
			mergeInto(survivor, elements);
			continue;
		}

		const id =
			sourceTrackId && !usedTrackIds.has(sourceTrackId) ? sourceTrackId : generateUUID();
		usedTrackIds.add(id);
		const track = (
			isNestedMain
				? {
						...buildEmptyTrack({ id, type: "video" }),
						muted: nested.tracks.main.muted,
						hidden: nested.tracks.main.hidden,
						elements,
					}
				: { ...nestedTrack, id, elements }
		) as TimelineTrack;
		for (const element of elements) restored.push({ trackId: id, elementId: element.id });
		if (track.type === "audio") {
			const at =
				findOriginalPosition(nextTracks.audio, order, sourceTrackId) ?? audioFallback++;
			nextTracks.audio.splice(at, 0, track);
		} else {
			const at =
				findOriginalPosition(nextTracks.overlay, order, sourceTrackId) ?? overlayFallback++;
			nextTracks.overlay.splice(at, 0, track);
		}
	}

	const nextScenes = scenes
		.filter((scene) => keepNested || scene.id !== nested.id)
		.map((scene) =>
			scene.id === hostSceneId
				? { ...scene, tracks: nextTracks, updatedAt: new Date() }
				: scene,
		);
	return { scenes: nextScenes, elements: restored };
}

// --- consistency (applied by the scenes manager on every change) ---

/**
 * Keeps every compound clip's sourceDuration equal to its nested scene's duration. A clip's
 * timeline span (startTime, duration, trimStart) never changes implicitly: growth becomes
 * trimEnd (the clip can then be extended); after shrinking, trimEnd is 0 and the clip shows
 * an empty tail until it is shortened. Pure and deterministic, so undo stays consistent.
 */
export function syncCompoundDurations(scenes: TScene[]): TScene[] {
	if (!scenes.some(isCompoundScene)) return scenes;
	// Spans are never touched here, so every scene duration can be read up front.
	const durations = new Map(
		scenes.map((scene) => [scene.id, calculateTotalDuration({ tracks: scene.tracks })]),
	);
	let changed = false;
	const next = scenes.map((scene) => {
		let sceneChanged = false;
		const syncTrack = <T extends TimelineTrack>(track: T): T => {
			let trackChanged = false;
			const elements = track.elements.map((element) => {
				if (!isCompoundElement(element)) return element;
				const sourceDuration = durations.get(element.sceneId);
				if (sourceDuration === undefined) return element;
				const trimEnd = Math.max(
					0,
					sourceDuration - element.trimStart - element.duration,
				) as MediaTime;
				if (element.sourceDuration === sourceDuration && element.trimEnd === trimEnd) {
					return element;
				}
				trackChanged = true;
				return { ...element, sourceDuration, trimEnd };
			});
			if (!trackChanged) return track;
			sceneChanged = true;
			return { ...track, elements } as T;
		};
		const tracks: SceneTracks = {
			overlay: scene.tracks.overlay.map(syncTrack),
			main: syncTrack(scene.tracks.main),
			audio: scene.tracks.audio.map(syncTrack),
		};
		if (!sceneChanged) return scene;
		changed = true;
		return { ...scene, tracks };
	});
	return changed ? next : scenes;
}

/** Throws CompoundCycleError if giving scene `sceneId` these `tracks` would make it contain itself. */
export function assertTracksAcyclic({
	scenes,
	sceneId,
	tracks,
}: {
	scenes: TScene[];
	sceneId: string;
	tracks: SceneTracks;
}): void {
	const referenced = getReferencedSceneIds(tracks);
	if (referenced.length === 0) return;
	const nextScenes = scenes.map((scene) => (scene.id === sceneId ? { ...scene, tracks } : scene));
	for (const fromSceneId of referenced) {
		if (sceneReachesScene({ scenes: nextScenes, fromSceneId, targetSceneId: sceneId })) {
			throw new CompoundCycleError(sceneId);
		}
	}
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
			keys: channel.keys.map((key) => ({ ...key, value: key.value + gainDb })),
		},
	};
}

/**
 * Returns `tracks` plus virtual tracks holding the audio of every compound clip (recursively):
 * nested audio/video elements cut to the compound's trim window, moved to parent time, with the
 * compound's volume added (dB, unclamped so nested gains add up; the final gain is clamped once
 * when converted to linear) and its mute applied. Only the audio mixers read these tracks.
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
			const gainDb = readVolumeDb(compound);
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
							...foldCompoundAudio({
								element: shiftElement(clipped, offset),
								gainDb,
								muted: false,
							}),
							// Unique per compound instance: one nested scene can be used by several clips.
							id: `${compound.id}/${element.id}`,
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

// --- blurred background ---

/**
 * Main-track media in parent time, looking through compound clips into their nested main
 * tracks (cut to each clip's trim window), so the blurred background keeps working after the
 * main-track video is grouped. Hidden elements and hidden nested main tracks are skipped.
 */
export function expandCompoundMainTrackMedia({
	elements,
	scenes,
	stack = [],
}: {
	elements: TimelineElement[];
	scenes: TScene[];
	stack?: string[];
}): TimelineElement[] {
	return elements.flatMap((element) => {
		if ("hidden" in element && element.hidden) return [];
		if (!isCompoundElement(element)) return [element];
		const nested = findScene(scenes, element.sceneId);
		if (!nested || nested.tracks.main.hidden || stack.includes(nested.id)) return [];
		const offset = element.startTime - element.trimStart;
		const rangeEnd = (element.trimStart + element.duration) as MediaTime;
		return expandCompoundMainTrackMedia({
			elements: nested.tracks.main.elements,
			scenes,
			stack: [...stack, nested.id],
		}).flatMap((inner) => {
			const clipped = clipElementToRange({
				element: inner,
				rangeStart: element.trimStart,
				rangeEnd,
			});
			return clipped ? [shiftElement(clipped, offset)] : [];
		});
	});
}
