import { describe, expect, test } from "bun:test";
import { renderTargetSize, scaleQuad } from "./scale";
import { previewQualityScale } from "../../preview/quality";

describe("preview scale", () => {
	test("sizes the target for each quality and keeps tiny dimensions valid", () => {
		expect(
			renderTargetSize({
				width: 1920,
				height: 1080,
				scale: previewQualityScale("full"),
			}),
		).toEqual({ width: 1920, height: 1080 });
		expect(
			renderTargetSize({
				width: 1920,
				height: 1080,
				scale: previewQualityScale("half"),
			}),
		).toEqual({ width: 960, height: 540 });
		expect(
			renderTargetSize({
				width: 1920,
				height: 1080,
				scale: previewQualityScale("quarter"),
			}),
		).toEqual({ width: 480, height: 270 });
		expect(renderTargetSize({ width: 1, height: 3, scale: 0.25 })).toEqual({
			width: 1,
			height: 1,
		});
	});
	test("preserves normalized placement and dimensions, rotation and flips", () => {
		const transform = {
			centerX: 1200,
			centerY: 390,
			width: 400,
			height: 200,
			rotationDegrees: 35,
			flipX: true,
			flipY: false,
		};
		for (const scale of [1, 0.5, 0.25]) {
			const result = scaleQuad({
				transform,
				width: 1920,
				height: 1080,
				targetWidth: 1920 * scale,
				targetHeight: 1080 * scale,
			});
			expect(result).toEqual({
				...transform,
				centerX: 1200 * scale,
				centerY: 390 * scale,
				width: 400 * scale,
				height: 200 * scale,
			});
		}
	});
});
