import { describe, expect, test } from "bun:test";
import {
	parseViewBox,
	progressDash,
	splitSubpaths,
	subpathProgress,
	viewBoxTransform,
} from "../definitions/strokes";
import { iconUrl } from "@/stickers/providers/iconify";

describe("stroke reveal", () => {
	test("clamps progress to the stroke length", () => {
		expect(progressDash(100, 0, 0)).toEqual([0, 101]);
		expect(progressDash(100, 0.5, 0)).toEqual([50, 101]);
		expect(progressDash(100, 2, 0)).toEqual([100, 101]);
	});
	test("preserves dashes up to the reveal boundary", () => {
		expect(progressDash(100, 0.25, 10)).toEqual([10, 10, 5, 101]);
		expect(progressDash(100, 0.2, 10)).toEqual([10, 10, 0, 101]);
	});
});

describe("icon URLs", () => {
	test("uses only an Iconify prefix and name", () => {
		expect(iconUrl("lucide:server")).toBe(
			"https://api.iconify.design/lucide/server.svg",
		);
		expect(() => iconUrl("../../x:y")).toThrow();
	});
});

describe("SVG paths", () => {
	test("accepts arbitrary viewBox origins and rejects invalid boxes", () => {
		expect(parseViewBox("-12, 3 24 48")).toEqual([-12, 3, 24, 48]);
		expect(parseViewBox("0 0 0 24")).toBeNull();
		const transform = viewBoxTransform([-12, 3, 24, 48], 240, 480);
		expect([
			(-12 + transform.translateX) * transform.scaleX,
			(3 + transform.translateY) * transform.scaleY,
		]).toEqual([0, 0]);
		expect([
			(12 + transform.translateX) * transform.scaleX,
			(51 + transform.translateY) * transform.scaleY,
		]).toEqual([240, 480]);
	});
	test("reveals subpaths sequentially by length", () => {
		expect(splitSubpaths("M2 2L22 2 M2 8L22 8 m1 1l2 2")).toEqual([
			"M2 2L22 2",
			"M2 8L22 8",
			"m1 1l2 2",
		]);
		expect(subpathProgress([20, 20, 10], 0.5)).toEqual([20, 5, 0]);
		expect(subpathProgress([20, 20, 10], 1)).toEqual([20, 20, 10]);
	});
});
