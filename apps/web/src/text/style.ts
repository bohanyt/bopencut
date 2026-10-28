import { resolveAnimationPathValueAtTime } from "@/animation";
import type { ParamDefinition, ParamValues } from "@/params";
import type { TextElement } from "@/timeline";

export const textStyleParams: ParamDefinition[] = [
	...["inner", "outer"].flatMap((layer): ParamDefinition[] => [
		{
			key: `stroke.${layer}.color`,
			label: `${layer === "inner" ? "Inner" : "Outer"} stroke color`,
			type: "color",
			default: "#000000",
		},
		{
			key: `stroke.${layer}.width`,
			label: `${layer === "inner" ? "Inner" : "Outer"} stroke (em)`,
			type: "number",
			default: 0,
			min: 0,
			max: 2,
			step: 0.01,
		},
		{
			key: `stroke.${layer}.widthPx`,
			label: `${layer === "inner" ? "Inner" : "Outer"} stroke (px; 0 uses em)`,
			type: "number",
			default: 0,
			min: 0,
			max: 1000,
			step: 0.1,
		},
	]),
	{
		key: "shadow.color",
		label: "Shadow color",
		type: "color",
		default: "#000000",
	},
	{
		key: "shadow.offsetX",
		label: "Shadow X (px)",
		type: "number",
		default: 0,
		min: -10000,
		max: 10000,
		step: 1,
	},
	{
		key: "shadow.offsetY",
		label: "Shadow Y (px)",
		type: "number",
		default: 0,
		min: -10000,
		max: 10000,
		step: 1,
	},
	{
		key: "shadow.blur",
		label: "Shadow blur (px)",
		type: "number",
		default: 0,
		min: 0,
		max: 1000,
		step: 1,
	},
	{
		key: "shadow.opacity",
		label: "Shadow opacity",
		type: "number",
		default: 0,
		min: 0,
		max: 1,
		step: 0.01,
	},
	{
		key: "caption.maxWidth",
		label: "Maximum line width (px; 0 wraps off)",
		type: "number",
		default: 0,
		min: 0,
		max: 100000,
		step: 1,
	},
	{
		key: "caption.noOrphan",
		label: "Avoid a last line of one word",
		type: "boolean",
		default: true,
		keyframable: false,
	},
	{
		key: "caption.wordSpacing",
		label: "Extra word spacing (em)",
		type: "number",
		default: 0,
		min: 0,
		max: 5,
		step: 0.01,
	},
	{
		key: "caption.highlightColor",
		label: "Emphasis word color",
		type: "color",
		default: "#ffff00",
	},
	{
		key: "caption.activeColor",
		label: "Active word color",
		type: "color",
		default: "#ffff00",
	},
	{
		key: "caption.activeEnabled",
		label: "Highlight active word",
		type: "boolean",
		default: false,
		keyframable: false,
	},
	{
		key: "caption.activeScale",
		label: "Active word scale",
		type: "number",
		default: 1,
		min: 1,
		max: 3,
		step: 0.01,
	},
];

export interface ResolvedTextStyle {
	strokes: { color: string; width: number }[];
	shadow: {
		color: string;
		offsetX: number;
		offsetY: number;
		blur: number;
		opacity: number;
	};
	highlightColor: string;
	activeColor: string;
	activeEnabled: boolean;
	activeScale: number;
}

export function textNumber(
	element: TextElement,
	key: string,
	fallback: number,
	localTime: number,
): number {
	const value = resolveAnimationPathValueAtTime({
		animations: element.animations,
		propertyPath: key,
		localTime,
		fallbackValue:
			typeof element.params[key] === "number" ? element.params[key] : fallback,
	});
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function strokeWidthInPixels(
	em: number,
	px: number,
	fontSizePx: number,
	animatedPx = false,
): number {
	return Math.max(0, px > 0 || animatedPx ? px : em * fontSizePx);
}

export function resolveTextStyle(
	element: TextElement,
	fontSizePx: number,
	localTime: number,
): ResolvedTextStyle {
	const number = (key: string, fallback = 0) =>
		textNumber(element, key, fallback, localTime);
	const color = (key: string, fallback: string): string =>
		resolveAnimationPathValueAtTime({
			animations: element.animations,
			propertyPath: key,
			localTime,
			fallbackValue:
				typeof element.params[key] === "string"
					? element.params[key]
					: fallback,
		});
	return {
		strokes: ["outer", "inner"].map((layer) => ({
			color: color(`stroke.${layer}.color`, "#000000"),
			width: strokeWidthInPixels(
				number(`stroke.${layer}.width`),
				number(`stroke.${layer}.widthPx`),
				fontSizePx,
				!!element.animations?.[`stroke.${layer}.widthPx`],
			),
		})),
		shadow: {
			color: color("shadow.color", "#000000"),
			offsetX: number("shadow.offsetX"),
			offsetY: number("shadow.offsetY"),
			blur: Math.max(0, number("shadow.blur")),
			opacity: Math.min(1, Math.max(0, number("shadow.opacity"))),
		},
		highlightColor: color("caption.highlightColor", "#ffff00"),
		activeColor: color("caption.activeColor", "#ffff00"),
		activeEnabled: element.params["caption.activeEnabled"] === true,
		activeScale: Math.max(1, number("caption.activeScale", 1)),
	};
}

export const TEXT_STYLE_KEYS = [
	"fontFamily",
	"fontSize",
	"color",
	"textAlign",
	"fontWeight",
	"fontStyle",
	"textDecoration",
	"letterSpacing",
	"lineHeight",
	"background.enabled",
	"background.color",
	"background.cornerRadius",
	"background.paddingX",
	"background.paddingY",
	"background.offsetX",
	"background.offsetY",
	...textStyleParams.map((param) => param.key),
];

/** Only typography and caption appearance belong to presets, never text, timing, or placement. */
export function pickTextStyle(params: ParamValues): ParamValues {
	return Object.fromEntries(
		Object.entries(params).filter(([key]) => TEXT_STYLE_KEYS.includes(key)),
	);
}
