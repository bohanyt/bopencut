"use client";

import { useEffect, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import type { TextElement } from "@/timeline";
import { TICKS_PER_SECOND } from "@/wasm";
import { makeCaption } from "../caption";
import {
	applyTextPreset,
	createTextPreset,
	loadTextPresets,
	saveTextPreset,
	type TextStylePreset,
} from "../presets";

export function CaptionProperties({
	element,
	trackId,
	presetsOnly = false,
}: {
	element: TextElement;
	trackId: string;
	presetsOnly?: boolean;
}) {
	const editor = useEditor();
	const [presets, setPresets] = useState<TextStylePreset[]>([]);
	const [name, setName] = useState("");
	const [chosen, setChosen] = useState("");
	const [busy, setBusy] = useState(false);
	const report = (error: unknown) =>
		toast.error(error instanceof Error ? error.message : String(error));
	useEffect(() => {
		loadTextPresets().then(setPresets).catch(report);
	}, []);
	const patch = (patch: Partial<TextElement>) =>
		editor.timeline.updateElements({
			updates: [{ trackId, elementId: element.id, patch }],
		});
	const save = async () => {
		setBusy(true);
		try {
			const preset = createTextPreset(
				name,
				element,
				Math.max(
					0,
					Math.min(
						element.duration,
						editor.playback.getCurrentTime() - element.startTime,
					),
				),
			);
			await saveTextPreset(preset);
			setPresets(await loadTextPresets());
			setChosen(preset.name);
			toast.success("Text style saved to workspace presets");
		} catch (error) {
			report(error);
		} finally {
			setBusy(false);
		}
	};
	const apply = () => {
		const preset = presets.find((preset) => preset.name === chosen);
		if (!preset) return;
		const selected = editor.selection.getSelectedElements();
		const refs = selected.length
			? selected
			: [{ trackId, elementId: element.id }];
		const tracks = editor.scenes.getActiveScene().tracks;
		const updates = refs.flatMap((ref) => {
			const track = [tracks.main, ...tracks.overlay, ...tracks.audio].find(
				(track) => track.id === ref.trackId,
			);
			const target = track?.elements.find(
				(target) => target.id === ref.elementId,
			);
			return target?.type === "text"
				? [{ ...ref, patch: applyTextPreset(target, preset) }]
				: [];
		});
		editor.timeline.updateElements({ updates });
		toast.success(`Style applied to ${updates.length} text elements`);
	};
	return (
		<div className="space-y-3 border-b p-4">
			<div className="text-sm font-medium">Text style presets</div>
			<div className="flex gap-2">
				<Input
					aria-label="Preset name"
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="Preset name"
				/>
				<Button size="sm" disabled={busy || !name.trim()} onClick={save}>
					Save
				</Button>
			</div>
			<div className="flex gap-2">
				<select
					aria-label="Text style preset"
					className="bg-background min-w-0 flex-1 rounded border px-2 text-sm"
					value={chosen}
					onChange={(event) => setChosen(event.target.value)}
				>
					<option value="">Choose a preset</option>
					{presets.map((preset) => (
						<option key={preset.name} value={preset.name}>
							{preset.name}
						</option>
					))}
				</select>
				<Button size="sm" disabled={!chosen} onClick={apply}>
					Apply to selected
				</Button>
			</div>
			{!presetsOnly &&
				(element.caption ? (
					<>
						<p className="text-muted-foreground text-xs">
							{element.caption.approximate
								? "Approximate word timings"
								: "Timed words"}
							. Edit the text below; matching words keep their timings.
						</p>
						<div className="flex flex-wrap gap-1" aria-label="Emphasis words">
							{element.caption.words.map((word, index) => (
								<Button
									key={index}
									size="sm"
									variant={word.highlight ? "secondary" : "ghost"}
									aria-pressed={!!word.highlight}
									title={`${word.start.toFixed(2)}–${word.end.toFixed(2)} s; toggle emphasis`}
									onClick={() =>
										patch({
											caption: {
												...element.caption!,
												words: element.caption!.words.map((entry, i) =>
													i === index
														? { ...entry, highlight: !entry.highlight }
														: entry,
												),
											},
										})
									}
								>
									{word.text}
								</Button>
							))}
						</div>
					</>
				) : (
					<div className="flex items-center justify-between text-sm">
						<span>Caption word timings</span>
						<Switch
							checked={false}
							onCheckedChange={() =>
								patch({
									caption: makeCaption(
										String(element.params.content ?? ""),
										element.duration / TICKS_PER_SECOND,
									),
									params: {
										...element.params,
										"caption.maxWidth":
											editor.project.getActive().settings.canvasSize.width *
											0.8,
									},
								})
							}
						/>
					</div>
				))}
		</div>
	);
}
