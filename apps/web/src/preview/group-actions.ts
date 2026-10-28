import type { EditorCore } from "@/core";

export function changeGroup(editor: EditorCore, ungroup: boolean): void {
	const selected = editor.selection.getSelectedElements();
	const tracks = editor.scenes.getActiveScene().tracks;
	const all = [...tracks.overlay, tracks.main, ...tracks.audio].flatMap(
		(track) =>
			track.elements.map((element) => ({ trackId: track.id, element })),
	);
	const ids = new Set(selected.map((ref) => ref.elementId));
	const groups = new Set(
		all
			.filter(({ element }) => ids.has(element.id) && element.groupId)
			.map(({ element }) => element.groupId),
	);
	const members = all.filter(
		({ element }) =>
			ids.has(element.id) || (element.groupId && groups.has(element.groupId)),
	);
	if ((!ungroup && members.length < 2) || (ungroup && groups.size === 0))
		return;
	const groupId = ungroup ? undefined : crypto.randomUUID();
	editor.timeline.updateElements({
		updates: members.map(({ trackId, element }) => ({
			trackId,
			elementId: element.id,
			patch: { groupId },
		})),
	});
	editor.selection.setSelectedElements({
		elements: members.map(({ trackId, element }) => ({
			trackId,
			elementId: element.id,
		})),
	});
}
