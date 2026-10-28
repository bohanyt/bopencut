import { afterEach, beforeEach, expect, test } from "bun:test";
import { createCanvas, Path2D } from "@napi-rs/canvas";
import { rectangleGraphicDefinition } from "../definitions/rectangle";
import { ellipseGraphicDefinition } from "../definitions/ellipse";
import { pathGraphicDefinition } from "../definitions/strokes";
import { glyphAnchorOffset, measureTextLayout } from "@/text/primitives";

const savedPath = Object.getOwnPropertyDescriptor(globalThis, "Path2D");
const savedDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
beforeEach(() => {
	Object.defineProperty(globalThis, "Path2D", { configurable: true, value: Path2D });
	Object.defineProperty(globalThis, "document", { configurable: true, value: {
		createElementNS: () => ({ setAttribute: () => {}, getTotalLength: () => 200 }),
	} });
});
afterEach(() => {
	if (savedPath) Object.defineProperty(globalThis, "Path2D", savedPath);
	else Reflect.deleteProperty(globalThis, "Path2D");
	if (savedDocument) Object.defineProperty(globalThis, "document", savedDocument);
	else Reflect.deleteProperty(globalThis, "document");
});

test("filled cubic paths preserve holes and transparent defaults", () => {
	const canvas = createCanvas(100, 100);
	const context = canvas.getContext("2d");
	const params = { d: "M10 10H90V90H10Z M30 30V70H70V30Z", viewBox: "0 0 100 100", fill: "#ff000080", strokeWidth: 0 };
	pathGraphicDefinition.render({ ctx: context as unknown as CanvasRenderingContext2D, width: 100, height: 100, params });
	expect(context.getImageData(20, 20, 1, 1).data[3]).toBeCloseTo(128, 0);
	expect(context.getImageData(50, 50, 1, 1).data[3]).toBe(0);
	context.clearRect(0, 0, 100, 100);
	pathGraphicDefinition.render({ ctx: context as unknown as CanvasRenderingContext2D, width: 100, height: 100, params: { ...params, fill: "#00000000" } });
	expect(context.getImageData(20, 20, 1, 1).data[3]).toBe(0);
});

test("inset primitive geometry keeps uniform stroke on rectangular shapes", () => {
	for (const definition of [rectangleGraphicDefinition, ellipseGraphicDefinition]) {
		const canvas = createCanvas(100, 100);
		const context = canvas.getContext("2d");
		definition.render({ ctx: context as unknown as CanvasRenderingContext2D, width: 100, height: 100,
			params: { shapeWidth: .8, shapeHeight: .4, fill: "#ffffff", stroke: "#ff0000", strokeWidth: 4 } });
		expect(context.getImageData(50, 10, 1, 1).data[3]).toBe(0);
		expect(context.getImageData(50, 50, 1, 1).data[3]).toBe(255);
		expect(context.getImageData(50, 31, 1, 1).data[1]).toBe(0);
	}
});

test("glyph anchoring centers measured ink without changing default text", () => {
	const context = createCanvas(200, 100).getContext("2d");
	const layout = measureTextLayout({ ctx: context as unknown as CanvasRenderingContext2D, canvasHeight: 1080,
		text: { content: "Example", fontFamily: "Arial", fontSize: 3, fontWeight: "normal", fontStyle: "normal", textAlign: "center", glyphAnchor: true } });
	const offset = glyphAnchorOffset(layout);
	const metric = layout.lineMetrics[0];
	expect(offset.y + (metric.actualBoundingBoxDescent - metric.actualBoundingBoxAscent) / 2).toBeCloseTo(0);
	expect(glyphAnchorOffset({ ...layout, glyphAnchor: false })).toEqual({ x: 0, y: 0 });
});
