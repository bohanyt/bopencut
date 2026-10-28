import type { ElementType, TScene, TrackType } from "@/timeline";
import { getCompoundTrackType } from "@/timeline/compound";

const ELEMENT_TRACK_MAP: Record<ElementType, TrackType> = {
	audio: "audio",
	text: "text",
	sticker: "graphic",
	graphic: "graphic",
	effect: "effect",
	video: "video",
	image: "video",
	// Default only; placement uses getTrackTypeForElement, which looks at the content.
	compound: "video",
};

export function getTrackTypeForElementType({
	elementType,
}: {
	elementType: ElementType;
}): TrackType {
	return ELEMENT_TRACK_MAP[elementType];
}

/** Required track type of a concrete element; compound clips depend on their nested content. */
export function getTrackTypeForElement({
	element,
	scenes,
}: {
	element: { type: ElementType; sceneId?: string };
	scenes: TScene[];
}): TrackType {
	if (element.type === "compound" && element.sceneId) {
		return getCompoundTrackType({ scenes, sceneId: element.sceneId });
	}
	return getTrackTypeForElementType({ elementType: element.type });
}

export function canElementGoOnTrack({
	elementType,
	trackType,
}: {
	elementType: ElementType;
	trackType: TrackType;
}): boolean {
	if (elementType === "compound") {
		return trackType === "video" || trackType === "audio";
	}
	return getTrackTypeForElementType({ elementType }) === trackType;
}

export function validateElementTrackCompatibility({
	element,
	track,
	scenes,
}: {
	element: { type: ElementType; sceneId?: string };
	track: { type: TrackType };
	scenes: TScene[];
}): { isValid: boolean; errorMessage?: string } {
	const isValid = getTrackTypeForElement({ element, scenes }) === track.type;

	if (!isValid) {
		return {
			isValid: false,
			errorMessage: `${element.type} elements cannot be placed on ${track.type} tracks`,
		};
	}

	return { isValid: true };
}
