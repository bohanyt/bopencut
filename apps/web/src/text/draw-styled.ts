import type { MeasuredTextElement } from "./measure-element";
import { drawMeasuredTextLayout } from "./primitives";
import {
	drawTextDecoration,
	setCanvasLetterSpacing,
	type TextCanvasContext,
} from "./layout";

function surface(
	width: number,
	height: number,
): OffscreenCanvas | HTMLCanvasElement {
	if (typeof OffscreenCanvas !== "undefined")
		return new OffscreenCanvas(width, height);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	return canvas;
}

function drawGlyphs(
	ctx: TextCanvasContext,
	layout: MeasuredTextElement,
	color: string,
	baseline: CanvasTextBaseline,
) {
	ctx.save();
	ctx.font = layout.fontString;
	ctx.textBaseline = baseline;
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	setCanvasLetterSpacing({ ctx, letterSpacingPx: layout.letterSpacing });
	const runs =
		layout.wordRuns ??
		layout.lines.map((text, index) => ({
			text,
			index: -1,
			x: 0,
			y: index * layout.lineHeightPx - layout.block.visualCenterOffset,
			width: layout.lineMetrics[index].width,
		}));
	ctx.textAlign = layout.wordRuns ? "left" : layout.textAlign;
	const draw = (stroke?: { color: string; width: number }) => {
		for (const run of runs) {
			const active =
				layout.style.activeEnabled &&
				run.index >= 0 &&
				run.index === layout.activeWord;
			ctx.save();
			ctx.translate(run.x, run.y);
			if (active && layout.style.activeScale !== 1) {
				ctx.translate(run.width / 2, 0);
				ctx.scale(layout.style.activeScale, layout.style.activeScale);
				ctx.translate(-run.width / 2, 0);
			}
			if (stroke) {
				ctx.strokeStyle = stroke.color;
				// Canvas strokes straddle the glyph edge; public widths describe the outward radius.
				ctx.lineWidth = stroke.width * 2;
				ctx.strokeText(run.text, 0, 0);
			} else {
				ctx.fillStyle = active
					? layout.style.activeColor
					: layout.emphasisWords.includes(run.index)
						? layout.style.highlightColor
						: color;
				ctx.fillText(run.text, 0, 0);
			}
			ctx.restore();
		}
	};
	for (const stroke of layout.style.strokes) if (stroke.width > 0) draw(stroke);
	draw();
	ctx.fillStyle = color;
	for (let i = 0; i < layout.lines.length; i++)
		drawTextDecoration({
			ctx,
			textDecoration: layout.textDecoration,
			lineWidth: layout.lineMetrics[i].width,
			lineY: i * layout.lineHeightPx - layout.block.visualCenterOffset,
			metrics: layout.lineMetrics[i],
			scaledFontSize: layout.scaledFontSize,
			textAlign: layout.textAlign,
		});
	ctx.restore();
}

/** Rasterize the combined glyph alpha once, so overlapping rings cast one shadow. */
export function drawStyledText({
	ctx,
	layout,
	textColor,
	backgroundColor,
	textBaseline = "middle",
}: {
	ctx: TextCanvasContext;
	layout: MeasuredTextElement;
	textColor: string;
	backgroundColor: string;
	textBaseline?: CanvasTextBaseline;
}): void {
	// The background is separate from the glyph silhouette.
	drawMeasuredTextLayout({
		ctx,
		layout,
		textColor,
		background: layout.resolvedBackground,
		backgroundColor,
		textBaseline,
		drawText: false,
	});
	const shadow = layout.style.shadow;
	if (shadow.opacity <= 0) {
		drawGlyphs(ctx, layout, textColor, textBaseline);
		return;
	}
	const rect = layout.visualRect;
	const transform = ctx.getTransform();
	const scale = Math.max(
		0.01,
		Math.hypot(transform.a, transform.b),
		Math.hypot(transform.c, transform.d),
	);
	// Guard browser canvas limits for extreme transforms; preserve logical geometry.
	const rasterScale = Math.min(
		scale,
		8192 / Math.max(1, rect.width, rect.height),
	);
	const width = Math.max(1, Math.ceil(rect.width * rasterScale));
	const height = Math.max(1, Math.ceil(rect.height * rasterScale));
	const glyphs = surface(width, height);
	const ink = glyphs.getContext("2d") as TextCanvasContext | null;
	if (!ink) return;
	ink.scale(rasterScale, rasterScale);
	ink.translate(-rect.left, -rect.top);
	drawGlyphs(ink, layout, textColor, textBaseline);
	const shade = surface(width, height);
	const mask = shade.getContext("2d") as TextCanvasContext | null;
	if (!mask) return;
	mask.filter =
		shadow.blur > 0 ? `blur(${shadow.blur * rasterScale}px)` : "none";
	mask.drawImage(
		glyphs,
		shadow.offsetX * rasterScale,
		shadow.offsetY * rasterScale,
	);
	mask.filter = "none";
	mask.globalCompositeOperation = "source-in";
	mask.fillStyle = shadow.color;
	mask.fillRect(0, 0, width, height);
	ctx.save();
	ctx.globalAlpha *= shadow.opacity;
	ctx.drawImage(
		shade,
		rect.left,
		rect.top,
		width / rasterScale,
		height / rasterScale,
	);
	ctx.restore();
	ctx.drawImage(
		glyphs,
		rect.left,
		rect.top,
		width / rasterScale,
		height / rasterScale,
	);
}
