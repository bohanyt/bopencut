"use client";

import {
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { usePreviewViewport } from "@/preview/components/preview-viewport";
import { useEditor } from "@/editor/use-editor";
import type { PreviewOverlayControl } from "@/preview/overlays";
import { useEffect } from "react";
import { changeGroup } from "@/preview/group-actions";
import { toast } from "sonner";

export function PreviewContextMenu({
	onToggleFullscreen,
	container,
	overlayControls,
	onOverlayVisibilityChange,
}: {
	onToggleFullscreen: () => void;
	container: HTMLElement | null;
	overlayControls: PreviewOverlayControl[];
	onOverlayVisibilityChange: (params: {
		overlayId: string;
		isVisible: boolean;
	}) => void;
}) {
	const editor = useEditor();
	const viewport = usePreviewViewport();
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (
				target?.isContentEditable ||
				/^(INPUT|TEXTAREA|SELECT)$/.test(target?.tagName ?? "")
			)
				return;
			if (
				(event.ctrlKey || event.metaKey) &&
				event.key.toLowerCase() === "g" &&
				!event.altKey
			) {
				event.preventDefault();
				changeGroup(editor, event.shiftKey);
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [editor]);

	const handleCopySnapshot = async () => {
		const result = await editor.renderer.copySnapshot();

		if (!result.success) {
			toast.error("Failed to copy snapshot", {
				description: result.error ?? "Please try again",
			});
			return;
		}
	};

	const handleSaveSnapshot = async () => {
		const result = await editor.renderer.saveSnapshot();

		if (!result.success) {
			toast.error("Failed to save snapshot", {
				description: result.error ?? "Please try again",
			});
			return;
		}
	};

	return (
		<ContextMenuContent className="w-56" container={container}>
			<ContextMenuItem onClick={() => changeGroup(editor, false)} inset>
				Group (Ctrl+G)
			</ContextMenuItem>
			<ContextMenuItem onClick={() => changeGroup(editor, true)} inset>
				Ungroup (Ctrl+Shift+G)
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem onClick={viewport.fitToScreen} inset>
				Fit to screen
			</ContextMenuItem>
			<ContextMenuSeparator />
			<ContextMenuItem onClick={onToggleFullscreen} inset>
				Full screen
			</ContextMenuItem>
			<ContextMenuItem onClick={handleSaveSnapshot} inset>
				Save snapshot
			</ContextMenuItem>
			<ContextMenuItem onClick={handleCopySnapshot} inset>
				Copy snapshot
			</ContextMenuItem>
			{overlayControls.length > 0 ? <ContextMenuSeparator /> : null}
			{overlayControls.map((overlayControl) => (
				<ContextMenuCheckboxItem
					key={overlayControl.id}
					checked={overlayControl.isVisible}
					onCheckedChange={(checked) =>
						onOverlayVisibilityChange({
							overlayId: overlayControl.id,
							isVisible: !!checked,
						})
					}
				>
					{overlayControl.label}
				</ContextMenuCheckboxItem>
			))}
		</ContextMenuContent>
	);
}
