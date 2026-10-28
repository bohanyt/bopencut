import type { ParamValues } from "@/params";
import type { TextElement } from "@/timeline";
import { buildTextElement } from "@/timeline/element-utils";
import { generateUUID } from "@/utils/id";
import { mediaTimeFromSeconds, TICKS_PER_SECOND } from "@/wasm";
import {
	makeCaption,
	reconcileCaptionEdit,
	type CaptionWord,
} from "@/text/caption";
import { validateTextPreset, type TextStylePreset } from "@/text/presets";
import type { AgentElement, PendingKeyframe } from "./elements";

export interface AgentCaption {
	text: string;
	words?: CaptionWord[];
	preset?: string;
	style?: ParamValues;
	highlight?: {
		color: string;
		emphasisColor?: string;
		scale?: number;
		enabled?: boolean;
	};
}

export function resolveCaptionPreset(
	caption: AgentCaption,
	presets: readonly TextStylePreset[],
): AgentCaption;
export function resolveCaptionPreset(
	caption: Partial<AgentCaption>,
	presets: readonly TextStylePreset[],
): Partial<AgentCaption>;
export function resolveCaptionPreset(
	caption: Partial<AgentCaption>,
	presets: readonly TextStylePreset[],
): Partial<AgentCaption> {
	if (!caption.preset) return caption;
	const preset = presets.find((preset) => preset.name === caption.preset);
	if (!preset) throw new Error(`Text preset not found: ${caption.preset}`);
	return {
		...caption,
		preset: undefined,
		style: { ...validateTextPreset(preset).style, ...caption.style },
	};
}

function captionStyle(caption: Partial<AgentCaption>): ParamValues {
	if (caption.preset)
		throw new Error(`Text preset has not been loaded: ${caption.preset}`);
	const style = validateTextPreset({
		name: "Style",
		style: caption.style ?? {},
	}).style;
	return {
		...style,
		...(caption.highlight
			? {
					"caption.activeEnabled": caption.highlight.enabled ?? true,
					"caption.activeColor": caption.highlight.color,
					"caption.highlightColor":
						caption.highlight.emphasisColor ?? caption.highlight.color,
					"caption.activeScale": caption.highlight.scale ?? 1,
				}
			: {}),
	};
}

export function updateAgentCaption(
	element: TextElement,
	caption: Partial<AgentCaption>,
): TextElement {
	const text = caption.text ?? String(element.params.content ?? "");
	const next = {
		...element,
		params: { ...element.params, ...captionStyle(caption), content: text },
	};
	if (caption.words || !element.caption)
		return {
			...next,
			caption: makeCaption(
				text,
				(element.duration + element.trimStart) / TICKS_PER_SECOND,
				caption.words,
			),
		};
	return reconcileCaptionEdit(element, next);
}

export function buildAgentCaption({
	e,
	trackId,
	sceneId,
	canvas,
	keyframes,
}: {
	e: AgentElement;
	trackId: string;
	sceneId?: string;
	canvas: { width: number; height: number };
	keyframes: PendingKeyframe[];
}): TextElement {
	if (!e.caption) throw new Error("Missing caption");
	const caption = e.caption;
	const base: TextElement = {
		...buildTextElement({
			raw: { name: e.name, params: { content: caption.text } },
			startTime: mediaTimeFromSeconds({ seconds: e.start }),
		}),
		id: generateUUID(),
		agentId: e.agent_id,
		groupId: e.group,
		duration: mediaTimeFromSeconds({ seconds: e.duration }),
	};
	const element = updateAgentCaption(
		{
			...base,
			params: {
				...base.params,
				"caption.maxWidth": canvas.width * 0.8,
				...e.params,
			},
		},
		caption,
	);
	for (const key of e.keyframes ?? []) {
		for (const propertyPath of key.path === "scale"
			? ["transform.scaleX", "transform.scaleY"]
			: [key.path]) {
			keyframes.push({
				trackId,
				sceneId,
				elementId: element.id,
				propertyPath,
				time: key.time,
				value: key.value,
			});
		}
	}
	return element;
}
