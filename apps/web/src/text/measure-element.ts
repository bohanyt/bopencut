import { CORNER_RADIUS_MIN } from "@/text/background";
import { DEFAULTS } from "@/timeline/defaults";
import type { TextElement } from "@/timeline";
import type { TextBackground } from "@/text/background";
import { resolveNumberAtTime } from "@/animation/values";
import { resolveTextStyle, textNumber, type ResolvedTextStyle } from "./style";
import { activeWordIndex } from "./caption";
import { TICKS_PER_SECOND } from "@/wasm";
import { getTextVisualRect, setCanvasLetterSpacing } from "./layout";
import {
	measureTextLayout,
	type MeasuredTextLayout,
	type TextAlign,
	type TextDecoration,
	type TextFontStyle,
	type TextFontWeight,
	type TextLayoutParams,
} from "./primitives";

export interface ResolvedTextBackground extends TextBackground {
	paddingX: number;
	paddingY: number;
	offsetX: number;
	offsetY: number;
	cornerRadius: number;
}

export interface MeasuredTextElement extends MeasuredTextLayout {
	resolvedBackground: ResolvedTextBackground;
	visualRect: { left: number; top: number; width: number; height: number };
	style: ResolvedTextStyle;
	activeWord: number;
	emphasisWords: number[];
}

let textMeasurementContext:
	| CanvasRenderingContext2D
	| OffscreenCanvasRenderingContext2D
	| null = null;

export function getTextMeasurementContext():
	| CanvasRenderingContext2D
	| OffscreenCanvasRenderingContext2D {
	if (textMeasurementContext) {
		return textMeasurementContext;
	}

	if (typeof OffscreenCanvas !== "undefined") {
		const canvas = new OffscreenCanvas(1, 1);
		const context = canvas.getContext("2d");
		if (context) {
			textMeasurementContext = context;
			return context;
		}
	}

	if (typeof document !== "undefined") {
		const canvas = document.createElement("canvas");
		const context = canvas.getContext("2d");
		if (context) {
			textMeasurementContext = context;
			return context;
		}
	}

	throw new Error("Failed to create text measurement context");
}

export function measureTextElement({
	element,
	canvasHeight,
	localTime,
	ctx,
}: {
	element: TextElement;
	canvasHeight: number;
	localTime: number;
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
}): MeasuredTextElement {
	const text = buildTextLayoutParamsFromElement({ element });
	text.fontSize = Math.max(
		1,
		textNumber(element, "fontSize", text.fontSize, localTime),
	);
	text.letterSpacing = textNumber(
		element,
		"letterSpacing",
		text.letterSpacing ?? 0,
		localTime,
	);
	text.lineHeight = Math.max(
		0.1,
		textNumber(element, "lineHeight", text.lineHeight ?? 1, localTime),
	);
	if (element.caption)
		text.caption = {
			maxWidth: textNumber(element, "caption.maxWidth", 0, localTime),
			noOrphan: element.params["caption.noOrphan"] !== false,
			wordSpacing: textNumber(element, "caption.wordSpacing", 0, localTime),
		};
	const measuredLayout = measureTextLayout({
		text,
		canvasHeight,
		ctx,
	});

	const bg = buildTextBackgroundFromElement({ element });
	const resolvedBackground: ResolvedTextBackground = {
		...bg,
		paddingX: resolveNumberAtTime({
			baseValue: bg.paddingX ?? DEFAULTS.text.background.paddingX,
			animations: element.animations,
			propertyPath: "background.paddingX",
			localTime,
		}),
		paddingY: resolveNumberAtTime({
			baseValue: bg.paddingY ?? DEFAULTS.text.background.paddingY,
			animations: element.animations,
			propertyPath: "background.paddingY",
			localTime,
		}),
		offsetX: resolveNumberAtTime({
			baseValue: bg.offsetX ?? DEFAULTS.text.background.offsetX,
			animations: element.animations,
			propertyPath: "background.offsetX",
			localTime,
		}),
		offsetY: resolveNumberAtTime({
			baseValue: bg.offsetY ?? DEFAULTS.text.background.offsetY,
			animations: element.animations,
			propertyPath: "background.offsetY",
			localTime,
		}),
		cornerRadius: resolveNumberAtTime({
			baseValue: bg.cornerRadius ?? CORNER_RADIUS_MIN,
			animations: element.animations,
			propertyPath: "background.cornerRadius",
			localTime,
		}),
	};

	const baseRect = getTextVisualRect({
		textAlign: text.textAlign,
		block: measuredLayout.block,
		background: resolvedBackground,
		fontSizeRatio: measuredLayout.fontSizeRatio,
	});
	const style = resolveTextStyle(
		element,
		measuredLayout.scaledFontSize,
		localTime,
	);
	const radius = Math.max(0, ...style.strokes.map((stroke) => stroke.width));
	// Include actual glyph overhangs and every potential active-word bump without moving the box during playback.
	let left = baseRect.left;
	let top = baseRect.top;
	let right = left + baseRect.width;
	let bottom = top + baseRect.height;
	if (element.caption || radius > 0 || style.shadow.opacity > 0) {
		ctx.save();
		ctx.font = measuredLayout.fontString;
		ctx.textBaseline = "middle";
		ctx.textAlign = "left";
		setCanvasLetterSpacing({
			ctx,
			letterSpacingPx: measuredLayout.letterSpacing,
		});
		const runs =
			measuredLayout.wordRuns ??
			measuredLayout.lines.map((text, index) => ({
				text,
				x:
					measuredLayout.textAlign === "left"
						? 0
						: -measuredLayout.lineMetrics[index].width /
							(measuredLayout.textAlign === "center" ? 2 : 1),
				y:
					index * measuredLayout.lineHeightPx -
					measuredLayout.block.visualCenterOffset,
				width: measuredLayout.lineMetrics[index].width,
			}));
		for (const run of runs) {
			const metric = ctx.measureText(run.text);
			const bump =
				element.caption && style.activeEnabled ? style.activeScale : 1;
			const center = run.x + run.width / 2;
			left = Math.min(
				left,
				center +
					(-metric.actualBoundingBoxLeft - run.width / 2 - radius) * bump -
					2,
			);
			right = Math.max(
				right,
				center +
					(metric.actualBoundingBoxRight - run.width / 2 + radius) * bump +
					2,
			);
			top = Math.min(
				top,
				run.y - (metric.actualBoundingBoxAscent + radius) * bump - 2,
			);
			bottom = Math.max(
				bottom,
				run.y + (metric.actualBoundingBoxDescent + radius) * bump + 2,
			);
		}
		ctx.restore();
	}
	const shadow = style.shadow;
	const blur = shadow.opacity > 0 ? shadow.blur * 3 : 0;
	const leftPad =
		blur + (shadow.opacity > 0 ? Math.max(0, -shadow.offsetX) : 0);
	const topPad = blur + (shadow.opacity > 0 ? Math.max(0, -shadow.offsetY) : 0);
	const visualRect = {
		left: left - leftPad,
		top: top - topPad,
		width:
			right -
			left +
			leftPad +
			blur +
			(shadow.opacity > 0 ? Math.max(0, shadow.offsetX) : 0),
		height:
			bottom -
			top +
			topPad +
			blur +
			(shadow.opacity > 0 ? Math.max(0, shadow.offsetY) : 0),
	};

	return {
		...measuredLayout,
		resolvedBackground,
		visualRect,
		style,
		activeWord: element.caption
			? activeWordIndex(
					element.caption.words,
					(localTime + element.trimStart) / TICKS_PER_SECOND,
				)
			: -1,
		emphasisWords:
			element.caption?.words.flatMap((word, index) =>
				word.highlight ? [index] : [],
			) ?? [],
	};
}

export function buildTextLayoutParamsFromElement({
	element,
}: {
	element: TextElement;
}): TextLayoutParams {
	return {
		content: readStringParam({
			params: element.params,
			key: "content",
			fallback: "Default text",
		}),
		fontSize: readNumberParam({
			params: element.params,
			key: "fontSize",
			fallback: 15,
		}),
		fontFamily: readStringParam({
			params: element.params,
			key: "fontFamily",
			fallback: "Arial",
		}),
		fontWeight: readFontWeight({
			value: element.params.fontWeight,
			fallback: "normal",
		}),
		fontStyle: readFontStyle({
			value: element.params.fontStyle,
			fallback: "normal",
		}),
		textAlign: readTextAlign({
			value: element.params.textAlign,
			fallback: "center",
		}),
		textDecoration: readTextDecoration({
			value: element.params.textDecoration,
			fallback: "none",
		}),
		letterSpacing: readNumberParam({
			params: element.params,
			key: "letterSpacing",
			fallback: DEFAULTS.text.letterSpacing,
		}),
		lineHeight: readNumberParam({
			params: element.params,
			key: "lineHeight",
			fallback: DEFAULTS.text.lineHeight,
		}),
	};
}

export function buildTextBackgroundFromElement({
	element,
}: {
	element: TextElement;
}): TextBackground {
	return {
		enabled: readBooleanParam({
			params: element.params,
			key: "background.enabled",
			fallback: DEFAULTS.text.background.enabled,
		}),
		color: readStringParam({
			params: element.params,
			key: "background.color",
			fallback: DEFAULTS.text.background.color,
		}),
		cornerRadius: readNumberParam({
			params: element.params,
			key: "background.cornerRadius",
			fallback: DEFAULTS.text.background.cornerRadius,
		}),
		paddingX: readNumberParam({
			params: element.params,
			key: "background.paddingX",
			fallback: DEFAULTS.text.background.paddingX,
		}),
		paddingY: readNumberParam({
			params: element.params,
			key: "background.paddingY",
			fallback: DEFAULTS.text.background.paddingY,
		}),
		offsetX: readNumberParam({
			params: element.params,
			key: "background.offsetX",
			fallback: DEFAULTS.text.background.offsetX,
		}),
		offsetY: readNumberParam({
			params: element.params,
			key: "background.offsetY",
			fallback: DEFAULTS.text.background.offsetY,
		}),
	};
}

function readStringParam({
	params,
	key,
	fallback,
}: {
	params: TextElement["params"];
	key: string;
	fallback: string;
}): string {
	const value = params[key];
	return typeof value === "string" ? value : fallback;
}

function readNumberParam({
	params,
	key,
	fallback,
}: {
	params: TextElement["params"];
	key: string;
	fallback: number;
}): number {
	const value = params[key];
	return typeof value === "number" ? value : fallback;
}

function readBooleanParam({
	params,
	key,
	fallback,
}: {
	params: TextElement["params"];
	key: string;
	fallback: boolean;
}): boolean {
	const value = params[key];
	return typeof value === "boolean" ? value : fallback;
}

function readTextAlign({
	value,
	fallback,
}: {
	value: unknown;
	fallback: TextAlign;
}): TextAlign {
	return value === "left" || value === "center" || value === "right"
		? value
		: fallback;
}

function readFontWeight({
	value,
	fallback,
}: {
	value: unknown;
	fallback: TextFontWeight;
}): TextFontWeight {
	return value === "bold" || value === "normal" ? value : fallback;
}

function readFontStyle({
	value,
	fallback,
}: {
	value: unknown;
	fallback: TextFontStyle;
}): TextFontStyle {
	return value === "italic" || value === "normal" ? value : fallback;
}

function readTextDecoration({
	value,
	fallback,
}: {
	value: unknown;
	fallback: TextDecoration;
}): TextDecoration {
	return value === "none" || value === "underline" || value === "line-through"
		? value
		: fallback;
}
