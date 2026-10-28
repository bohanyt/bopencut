"use client";

import { useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import type { CompoundElement } from "@/timeline";

export function CompoundTab({
	element,
	trackId,
}: {
	element: CompoundElement;
	trackId: string;
}) {
	const editor = useEditor();
	const [draft, setDraft] = useState<string | null>(null);

	const commitName = () => {
		const name = draft?.trim();
		setDraft(null);
		if (!name || name === element.name) return;
		editor.timeline.renameCompound({ sceneId: element.sceneId, name });
	};

	return (
		<Section sectionKey={`${element.id}:compound`}>
			<SectionHeader>
				<SectionTitle>Compound clip</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<SectionField label="Name">
						<Input
							size="sm"
							aria-label="Compound clip name"
							value={draft ?? element.name}
							onChange={(event) => setDraft(event.target.value)}
							onBlur={commitName}
							onKeyDown={(event) => {
								if (event.key === "Enter") event.currentTarget.blur();
							}}
						/>
					</SectionField>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="secondary"
							className="flex-1"
							onClick={() =>
								void editor.scenes.enterCompound({
									trackId,
									elementId: element.id,
								})
							}
						>
							Open
						</Button>
						<Button
							size="sm"
							variant="secondary"
							className="flex-1"
							onClick={() =>
								editor.timeline.ungroupCompound({
									trackId,
									elementId: element.id,
								})
							}
						>
							Break apart
						</Button>
					</div>
					<p className="text-muted-foreground text-xs">
						Double-click the clip to edit inside it. Volume applies to all nested audio
						and cannot be keyframed.
					</p>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
