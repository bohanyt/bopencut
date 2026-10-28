"use client";

import { Fragment, useMemo } from "react";
import { useEditor } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { ArrowLeft01Icon, Layers01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { TIMELINE_COMPOUND_THEME } from "./theme";

/** Shown while a compound clip is open: Main › Compound clip 2 › …, ancestors clickable. */
export function CompoundBreadcrumb() {
	const editor = useEditor();
	const scenes = useEditor((e) => e.scenes.getScenes());
	const activeScene = useEditor((e) => e.scenes.getActiveSceneOrNull());
	const path = useMemo(
		() => (scenes && activeScene ? editor.scenes.getCompoundPath() : []),
		[editor, scenes, activeScene],
	);

	if (path.length < 2) return null;

	return (
		<div className="flex h-8 shrink-0 items-center gap-1 border-b px-2">
			<Button
				variant="text"
				size="icon"
				className="size-6"
				aria-label="Back to parent (Esc)"
				title="Back to parent (Esc)"
				onClick={() => editor.scenes.exitCompound()}
			>
				<HugeiconsIcon icon={ArrowLeft01Icon} size={14} />
			</Button>
			<Breadcrumb aria-label="Compound clip path">
				<BreadcrumbList className="gap-1 text-xs sm:gap-1.5">
					{path.map((crumb, index) => (
						<Fragment key={crumb.sceneId}>
							{index > 0 && <BreadcrumbSeparator />}
							<BreadcrumbItem>
								{index === path.length - 1 ? (
									<BreadcrumbPage className="flex items-center gap-1 font-medium">
										<HugeiconsIcon
											icon={Layers01Icon}
											size={12}
											style={{ color: TIMELINE_COMPOUND_THEME.accentColor }}
										/>
										{crumb.name}
									</BreadcrumbPage>
								) : (
									<BreadcrumbLink asChild>
										<button
											type="button"
											className="cursor-pointer"
											onClick={() =>
												void editor.scenes.switchToScene({ sceneId: crumb.sceneId })
											}
										>
											{crumb.name}
										</button>
									</BreadcrumbLink>
								)}
							</BreadcrumbItem>
						</Fragment>
					))}
				</BreadcrumbList>
			</Breadcrumb>
		</div>
	);
}
