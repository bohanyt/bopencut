import { toast } from "sonner";
import { PasteCommand } from "@/commands/timeline";
import { collectCompoundScenes } from "@/timeline/compound";
import type { CreateTimelineElement, TScene } from "@/timeline";
import type { ClipboardHandler } from "../types";

/** Media ids the copied clips use, inside copied compound clips too. */
function getReferencedMediaIds({
	elements,
	scenes,
}: {
	elements: CreateTimelineElement[];
	scenes: TScene[];
}): Set<string> {
	const nested = scenes.flatMap((scene) =>
		[...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio].flatMap(
			(track): CreateTimelineElement[] => track.elements,
		),
	);
	const ids = new Set<string>();
	for (const element of [...elements, ...nested]) {
		if ("mediaId" in element && typeof element.mediaId === "string") {
			ids.add(element.mediaId);
		}
	}
	return ids;
}

export const ElementsClipboardHandler = {
	type: "elements",

	canCopy({ selectedElements }) {
		return selectedElements.length > 0;
	},

	copy({ editor, selectedElements }) {
		if (selectedElements.length === 0) {
			return null;
		}

		const results = editor.timeline.getElementsWithTracks({
			elements: selectedElements,
		});
		const items = results.map(({ track, element }) => {
			const { id: _elementId, ...elementWithoutId } = element;
			return {
				trackId: track.id,
				trackType: track.type,
				element: elementWithoutId,
			};
		});

		if (items.length === 0) {
			return null;
		}

		return {
			type: "elements",
			items,
			scenes: collectCompoundScenes({
				scenes: editor.scenes.getScenes(),
				elements: results.map(({ element }) => element),
			}),
		};
	},

	paste({ entry, context }) {
		if (entry.items.length === 0) {
			return null;
		}

		// Media is per project: clips copied in another project would paste as missing content.
		const available = new Set(context.editor.media.getAssets().map((asset) => asset.id));
		const missing = [
			...getReferencedMediaIds({
				elements: entry.items.map((item) => item.element),
				scenes: entry.scenes,
			}),
		].filter((mediaId) => !available.has(mediaId));
		if (missing.length > 0) {
			toast.error(
				"Cannot paste: the copied clips use media that is not in this project. Import the media here first.",
			);
			return null;
		}

		return new PasteCommand({
			time: context.time,
			clipboardItems: entry.items,
			scenes: entry.scenes,
		});
	},
} satisfies ClipboardHandler<"elements">;
