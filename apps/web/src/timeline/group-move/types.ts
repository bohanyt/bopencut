import type { ElementRef, ElementType, TrackType } from "@/timeline";
import type { MediaTime } from "@/wasm";

export type GroupTrackSection = "overlay" | "main" | "audio";

export interface GroupMember extends ElementRef {
	elementType: ElementType;
	/** Type of the track the element sits on now: the track type it needs (content-aware for compound clips). */
	trackType: TrackType;
	duration: MediaTime;
	timeOffset: MediaTime;
	trackSection: GroupTrackSection;
	sectionIndex: number;
	displayIndex: number;
}

export interface MoveGroup {
	anchor: GroupMember;
	members: GroupMember[];
}

export interface PlannedTrackCreation {
	id: string;
	type: TrackType;
	index: number;
}

export interface PlannedElementMove {
	sourceTrackId: string;
	targetTrackId: string;
	elementId: string;
	newStartTime: MediaTime;
}

export interface GroupMoveResult {
	moves: PlannedElementMove[];
	createTracks: PlannedTrackCreation[];
	targetSelection: ElementRef[];
}
