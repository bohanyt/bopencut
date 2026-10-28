import type { ElementType, TrackType } from "@/timeline";

const ELEMENT_TRACK_MAP: Record<ElementType, TrackType> = {
	audio: "audio",
	text: "text",
	sticker: "graphic",
	graphic: "graphic",
	effect: "effect",
	video: "video",
	image: "video",
	// Default only; the real rule depends on content (see getCompoundTrackType in timeline/compound).
	compound: "video",
};

export function getTrackTypeForElementType({
	elementType,
}: {
	elementType: ElementType;
}): TrackType {
	return ELEMENT_TRACK_MAP[elementType];
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
}: {
	element: { type: ElementType };
	track: { type: TrackType };
}): { isValid: boolean; errorMessage?: string } {
	const isValid = canElementGoOnTrack({
		elementType: element.type,
		trackType: track.type,
	});

	if (!isValid) {
		return {
			isValid: false,
			errorMessage: `${element.type} elements cannot be placed on ${track.type} tracks`,
		};
	}

	return { isValid: true };
}
