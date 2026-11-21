// In and out animation presets for a clip: drawn on top of the clip's own animation, so its keyframes
// stay as they are, and trims, speed changes and copies keep them.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useEditor } from "@/editor/use-editor";
import { NumberField } from "@/components/ui/number-field";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
	SectionHeader,
	SectionTitle,
} from "@/components/section";
import {
	ANIMATION_IN_TYPES,
	ANIMATION_OUT_TYPES,
	DEFAULT_IN_SECONDS,
	DEFAULT_OUT_SECONDS,
	PRESET_PARAM,
	type AnimationPresetRequest,
	applyAnimationPresets,
	readAnimationPresets,
	readPresetSettings,
} from "@/animation/presets";
import { getPresetDurationRange } from "@/animation/duration-control";
import type { TimelineElement } from "@/timeline";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";

const LABELS: Record<string, string> = {
	none: "None",
	fade: "Fade",
	pop: "Pop",
	impact: "Impact",
	blur: "Blur",
	typewriter: "Typewriter",
	fall: "Fall",
	dissolve: "Dissolve",
};

function PresetSide({
	side,
	element,
	trackId,
	current,
	onApply,
}: {
	side: "in" | "out";
	element: TimelineElement;
	trackId: string;
	current: { type: string; duration: number } | null;
	onApply: (request: AnimationPresetRequest) => void;
}) {
	const types = (side === "in" ? ANIMATION_IN_TYPES : ANIMATION_OUT_TYPES).filter(
		(type) => type !== "typewriter" || element.type === "text",
	);
	const type = current?.type ?? "none";
	const apply = (nextType: string, seconds?: number) =>
		onApply({ [side]: { type: nextType, ...(seconds ? { duration: seconds } : {}) } } as AnimationPresetRequest);
	return (
		<>
			<SectionField label={side === "in" ? "In" : "Out"}>
				<Select value={type} onValueChange={(next) => apply(next)}>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{["none", ...types].map((option) => (
							<SelectItem key={option} value={option}>
								{LABELS[option] ?? option}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</SectionField>
			{current && (
				<PresetDuration
					key={type}
					side={side}
					element={element}
					trackId={trackId}
					duration={current.duration}
					defaultDuration={side === "in"
						? DEFAULT_IN_SECONDS[type as keyof typeof DEFAULT_IN_SECONDS]
						: DEFAULT_OUT_SECONDS[type as keyof typeof DEFAULT_OUT_SECONDS]}
					onApply={(seconds) => apply(type, seconds)}
				/>
			)}
		</>
	);
}

function PresetDuration({
	side,
	element,
	trackId,
	duration,
	defaultDuration,
	onApply,
}: {
	side: "in" | "out";
	element: TimelineElement;
	trackId: string;
	duration: number;
	defaultDuration: number;
	onApply: (seconds: number) => void;
}) {
	const { timeline } = useEditor();
	const { min, max } = getPresetDurationRange(element.duration);
	const clampDuration = (seconds: number) => Math.min(max, Math.max(min, seconds));
	const value = clampDuration(duration);
	const resetValue = clampDuration(defaultDuration);
	const [draft, setDraft] = useState<string | null>(null);
	const drag = useRef<{ pointerId: number; previewing: boolean } | null>(null);
	const label = side === "in" ? "In length" : "Out length";
	const durationKey = side === "in" ? PRESET_PARAM.inDuration : PRESET_PARAM.outDuration;

	useEffect(() => {
		const finish = (event: PointerEvent) => {
			if (drag.current?.pointerId !== event.pointerId) return;
			const { previewing } = drag.current;
			drag.current = null;
			if (!previewing) return;
			if (event.type === "pointercancel") timeline.discardPreview();
			else timeline.commitPreview();
		};
		window.addEventListener("pointerup", finish);
		window.addEventListener("pointercancel", finish);
		return () => {
			window.removeEventListener("pointerup", finish);
			window.removeEventListener("pointercancel", finish);
			if (drag.current?.previewing) timeline.discardPreview();
			drag.current = null;
		};
	}, [timeline]);

	return (
		<SectionField label="Length">
			<div className="flex items-center gap-3">
				<input
					type="range"
					aria-label={label}
					min={min}
					max={max}
					step="any"
					value={value}
					disabled={min === max}
					className="accent-primary min-w-0 flex-1 disabled:opacity-50"
					onPointerDown={(event) => {
						if (event.button === 0 && event.isPrimary) {
							// Commit a focused number field before the range input starts changing.
							event.currentTarget.focus();
							drag.current = { pointerId: event.pointerId, previewing: false };
						}
					}}
					onChange={(event) => {
						const raw = event.currentTarget.valueAsNumber;
						const gesture = drag.current;
						// The range input serializes fractional endpoints with reduced precision.
						const seconds = Math.abs(raw - max) < 1e-12
							? max
							: gesture ? clampDuration(Math.round(raw * 100) / 100) : raw;
						const committed = timeline.getTrackById({ trackId })?.elements.find(
							(clip) => clip.id === element.id,
						);
						if (!committed) return;
						if (seconds === readPresetSettings(committed.params)[side]?.seconds) {
							if (gesture?.previewing) {
								timeline.discardPreview();
								gesture.previewing = false;
							}
							return;
						}
						timeline.previewElements({
							updates: [{
								trackId,
								elementId: element.id,
								updates: { params: { ...committed.params, [durationKey]: seconds } },
							}],
						});
						if (gesture) gesture.previewing = true;
						else timeline.commitPreview();
					}}
				/>
				<NumberField
					aria-label={`${label} in seconds`}
					className="w-24 shrink-0 [&_input]:pr-4"
					value={draft ?? String(Number(value.toFixed(3)))}
					suffix="s"
					suffixClassName="right-2 left-auto!"
					disabled={min === max}
					onChange={(event) => setDraft(event.target.value)}
					onBlur={() => {
						if (draft === null) return;
						const seconds = Number.parseFloat(draft);
						setDraft(null);
						if (!Number.isFinite(seconds)) return;
						const next = clampDuration(seconds);
						if (next !== duration) onApply(next);
					}}
					isDefault={duration === resetValue}
					onReset={() => onApply(resetValue)}
				/>
			</div>
		</SectionField>
	);
}

export function AnimationTab({
	element,
	trackId,
}: {
	element: TimelineElement;
	trackId: string;
}) {
	const editor = useEditor();
	const { renderElement } = useElementPreview({ trackId, elementId: element.id, fallback: element });
	const presets = readAnimationPresets(renderElement);
	const onApply = (request: AnimationPresetRequest) => {
		let next: TimelineElement;
		try {
			next = applyAnimationPresets(element, request);
		} catch (error) {
			toast.error("Animation not applied", { description: error instanceof Error ? error.message : String(error) });
			return;
		}
		// One edit, so one undo.
		editor.timeline.updateElements({
			updates: [{ trackId, elementId: element.id, patch: { params: next.params } }],
		});
	};
	return (
		<Section collapsible sectionKey={`${element.id}:animation`}>
			<SectionHeader>
				<SectionTitle>Animation</SectionTitle>
			</SectionHeader>
			<SectionContent>
				<SectionFields>
					<PresetSide side="in" element={renderElement} trackId={trackId} current={presets.in} onApply={onApply} />
					<PresetSide side="out" element={renderElement} trackId={trackId} current={presets.out} onApply={onApply} />
					<p className="text-muted-foreground text-xs">
						Drawn on top of the clip's own keyframes; on a short clip both are shortened to fit.
					</p>
				</SectionFields>
			</SectionContent>
		</Section>
	);
}
