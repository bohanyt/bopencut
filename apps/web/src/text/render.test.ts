import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { Canvas, createCanvas } from "@napi-rs/canvas";
import { measureTextElement } from "./measure-element";
import { drawStyledText } from "./draw-styled";
import { makeCaption } from "./caption";
import type { TextElement } from "@/timeline";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";
import type { CanvasRenderer } from "@/services/renderer/canvas-renderer";

const previous = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
beforeAll(() =>
	Object.defineProperty(globalThis, "OffscreenCanvas", {
		configurable: true,
		writable: true,
		value: Canvas,
	}),
);
afterAll(() => {
	if (previous) Object.defineProperty(globalThis, "OffscreenCanvas", previous);
	else Reflect.deleteProperty(globalThis, "OffscreenCanvas");
});
const time = (seconds: number) =>
	Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const element: TextElement = {
	id: "caption",
	name: "Caption",
	type: "text",
	startTime: time(0),
	duration: time(2),
	trimStart: time(0),
	trimEnd: time(0),
	caption: makeCaption("Hello world", 2, [
		{ text: "Hello", start: 0, end: 1 },
		{ text: "world", start: 1, end: 2, highlight: true },
	]),
	params: {
		content: "Hello world",
		fontFamily: "Arial",
		fontSize: 15,
		"stroke.outer.color": "#ff0000",
		"stroke.outer.width": 0.25,
		"stroke.inner.color": "#000000",
		"stroke.inner.width": 0.12,
		"shadow.color": "#000000",
		"shadow.opacity": 0.6,
		"shadow.offsetX": 16,
		"shadow.offsetY": 14,
		"caption.activeEnabled": true,
		"caption.activeColor": "#00ff00",
		"caption.highlightColor": "#0000ff",
	},
};

function render(scale: number, localTime = 0.5, target = element) {
	const canvas = createCanvas(640 * scale, 360 * scale);
	const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
	const layout = measureTextElement({
		element: target,
		canvasHeight: 360,
		localTime: time(localTime),
		ctx,
	});
	ctx.scale(scale, scale);
	ctx.translate(320, 180);
	drawStyledText({
		ctx,
		layout,
		textColor: "#ffffff",
		backgroundColor: "transparent",
	});
	return {
		canvas,
		ctx,
		layout,
		pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
	};
}

test("raster shows both rings, one shadow, emphasis and the active-word fill", () => {
	const { pixels } = render(1);
	const counts = { red: 0, black: 0, blue: 0, green: 0, shadow: 0 };
	for (let i = 0; i < pixels.length; i += 4) {
		const [r, g, b, a] = pixels.slice(i, i + 4);
		if (r === 255 && g === 0 && b === 0 && a === 255) counts.red++;
		if (r === 0 && g === 0 && b === 0 && a === 255) counts.black++;
		if (r === 0 && g === 0 && b === 255 && a === 255) counts.blue++;
		if (r === 0 && g === 255 && b === 0 && a === 255) counts.green++;
		if (r === 0 && g === 0 && b === 0 && Math.abs(a - 153) <= 1)
			counts.shadow++;
	}
	for (const [name, count] of Object.entries(counts))
		expect(count, name).toBeGreaterThan(50);
	expect(render(1, 1.5).layout.activeWord).toBe(1);
});

test("half and quarter quality scale the complete glyph silhouette and shadow", () => {
	const bounds = (scale: number) => {
		const { canvas, pixels } = render(scale);
		let left = canvas.width,
			right = 0,
			top = canvas.height,
			bottom = 0;
		for (let y = 0; y < canvas.height; y++)
			for (let x = 0; x < canvas.width; x++) {
				if (pixels[(y * canvas.width + x) * 4 + 3] < 20) continue;
				left = Math.min(left, x);
				right = Math.max(right, x);
				top = Math.min(top, y);
				bottom = Math.max(bottom, y);
			}
		return [left, right, top, bottom].map((value) => value / scale);
	};
	const full = bounds(1);
	for (const scale of [0.5, 0.25])
		bounds(scale).forEach((value, i) =>
			expect(Math.abs(value - full[i])).toBeLessThanOrEqual(5),
		);
});

test("font size, spacing and line-height keyframes resolve before measurement", () => {
	const target: TextElement = {
		...element,
		animations: {
			fontSize: {
				keys: [
					{
						id: "font",
						time: time(0),
						value: 20,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
			lineHeight: {
				keys: [
					{
						id: "line",
						time: time(0),
						value: 1.5,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
			letterSpacing: {
				keys: [
					{
						id: "spacing",
						time: time(0),
						value: 2,
						segmentToNext: "linear",
						tangentMode: "auto",
					},
				],
			},
		},
	};
	const { layout } = render(1, 0, target);
	expect(layout.scaledFontSize).toBe(80);
	expect(layout.lineHeightPx).toBe(120);
	expect(layout.letterSpacing).toBe(2);
});

test("400 phrase traversal activates only visible captions and clears the previous frame", async () => {
	mock.module("@/services/renderer/compositor/wasm-compositor", () => ({
		wasmCompositor: {},
	}));
	mock.module("@/services/renderer/gpu-renderer", () => ({
		gpuRenderer: {},
		initializeGpuRenderer: async () => {},
		isGpuAvailable: () => false,
	}));
	const { resolveRenderTree } = await import("@/services/renderer/resolve");
	const { RootNode } = await import("@/services/renderer/nodes/root-node");
	const { TextNode } = await import("@/services/renderer/nodes/text-node");
	const nodes = Array.from(
		{ length: 400 },
		(_, i) =>
			new TextNode({
				...element,
				id: `caption-${i}`,
				startTime: time(i * 3),
				transform: {
					position: { x: 0, y: 0 },
					scaleX: 1,
					scaleY: 1,
					rotate: 0,
				},
				opacity: 1,
				canvasCenter: { x: 320, y: 180 },
				canvasHeight: 360,
			}),
	);
	const root = new RootNode({ duration: time(1200) });
	for (const node of nodes) root.add(node);
	const renderer = {
		width: 640,
		height: 360,
		outputWidth: 640,
		outputHeight: 360,
		renderScale: 1,
	} as CanvasRenderer;
	await resolveRenderTree({ node: root, renderer, time: time(0.5) });
	expect(nodes.filter((node) => node.resolved)).toHaveLength(1);
	expect(nodes[0].resolved?.measuredText.activeWord).toBe(0);
	await resolveRenderTree({ node: root, renderer, time: time(3.5) });
	expect(nodes[0].resolved).toBeNull();
	expect(nodes[1].resolved?.measuredText.activeWord).toBe(0);
	await resolveRenderTree({ node: root, renderer, time: time(1200) });
	expect(nodes.every((node) => node.resolved === null)).toBe(true);
});
