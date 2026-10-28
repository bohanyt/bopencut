import {
	Command,
	createElementSelectionResult,
	type CommandResult,
} from "@/commands/base-command";
import type { SceneTracks, TScene, TimelineElement } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import { applyPlacement, resolveTrackPlacement } from "@/timeline/placement";
import { cloneAnimations } from "@/animation";
import type { MediaTime } from "@/wasm";
import { applyCopiedScenes, removeCopiedScenes } from "./copied-scenes";
import {
	collectCompoundScenes,
	deepCopyCompoundElements,
} from "@/timeline/compound";

interface DuplicateElementsParams {
	elements: { trackId: string; elementId: string }[];
}

export class DuplicateElementsCommand extends Command {
	private duplicatedElements: { trackId: string; elementId: string }[] = [];
	private savedState: SceneTracks | null = null;
	/** First result, replayed on redo so element, track, and nested scene ids stay the same. */
	private result: { tracks: SceneTracks; scenes: TScene[] } | null = null;
	private elements: DuplicateElementsParams["elements"];

	constructor({ elements }: DuplicateElementsParams) {
		super();
		this.elements = elements;
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;
		if (this.result) {
			applyCopiedScenes({ ...this.result });
			return this.duplicatedElements.length > 0
				? createElementSelectionResult(this.duplicatedElements)
				: undefined;
		}
		this.duplicatedElements = [];

		const tracks = [
			...this.savedState.overlay,
			this.savedState.main,
			...this.savedState.audio,
		];
		const selected = new Set(
			this.elements.map(({ trackId, elementId }) => `${trackId}\u0000${elementId}`),
		);
		const sources = tracks.flatMap((track) =>
			track.elements.filter((element) => selected.has(`${track.id}\u0000${element.id}`)),
		);
		// Duplicated compound clips get their own copy of their nested scenes (one copy pass, so
		// clips that shared a scene still share its copy).
		const deepCopy = deepCopyCompoundElements({
			elements: sources.map((element) =>
				buildDuplicateElement({
					element,
					id: generateUUID(),
					startTime: element.startTime,
				}),
			),
			sourceScenes: editor.scenes.getScenes(),
		});
		const duplicateOf = new Map(
			sources.map((element, index) => [element, deepCopy.elements[index]]),
		);
		const placed: TimelineElement[] = [];

		let updatedTracks = this.savedState;

		for (const track of tracks) {
			const newTrackElements = track.elements.flatMap((element) => {
				const duplicate = duplicateOf.get(element);
				return duplicate ? [duplicate] : [];
			});

			if (newTrackElements.length === 0) {
				continue;
			}

			const placementResult = resolveTrackPlacement({
				tracks: updatedTracks,
				trackType: track.type,
				timeSpans: [],
				strategy: { type: "alwaysNew", position: "highest" },
			});
			if (!placementResult || placementResult.kind !== "newTrack") {
				continue;
			}

			const applied = applyPlacement({
				tracks: updatedTracks,
				placementResult,
				elements: newTrackElements,
			});
			if (!applied) {
				continue;
			}

			updatedTracks = applied.updatedTracks;
			placed.push(...newTrackElements);

			for (const element of newTrackElements) {
				this.duplicatedElements.push({
					trackId: applied.targetTrackId,
					elementId: element.id,
				});
			}
		}

		const copiedScenes = collectCompoundScenes({
			scenes: deepCopy.scenes,
			elements: placed,
		});
		this.result = { tracks: updatedTracks, scenes: copiedScenes };
		applyCopiedScenes({ ...this.result });

		if (this.duplicatedElements.length > 0) {
			return createElementSelectionResult(this.duplicatedElements);
		}
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			removeCopiedScenes({
				tracks: this.savedState,
				scenes: this.result?.scenes ?? [],
			});
		}
	}

	getDuplicatedElements(): { trackId: string; elementId: string }[] {
		return this.duplicatedElements;
	}
}

function buildDuplicateElement({
	element,
	id,
	startTime,
}: {
	element: TimelineElement;
	id: string;
	startTime: MediaTime;
}): TimelineElement {
	return {
		...element,
		id,
		name: `${element.name} (copy)`,
		startTime,
		animations: cloneAnimations({
			animations: element.animations,
			shouldRegenerateKeyframeIds: true,
		}),
	};
}
