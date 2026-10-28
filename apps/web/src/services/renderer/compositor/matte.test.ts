import { describe, expect, test } from "bun:test";
import { matteFromBlackAndWhite } from "./matte";

// Composite one straight-alpha pixel over an opaque background, like the compositor does.
function over(pixel: number[], background: number): number[] {
	const a = pixel[3] / 255;
	return [0, 1, 2].map((c) => Math.round(pixel[c] * a + background * (1 - a))).concat(255);
}

describe("matteFromBlackAndWhite", () => {
	test("recovers straight colour and alpha from renders over black and white", () => {
		const pixels = [
			[255, 32, 80, 255],
			[255, 255, 255, 128],
			[0, 0, 0, 0],
			[40, 200, 120, 64],
		];
		const black = new Uint8ClampedArray(pixels.flatMap((p) => over(p, 0)));
		const white = new Uint8ClampedArray(pixels.flatMap((p) => over(p, 255)));
		const out = new Uint8ClampedArray(black.length);
		matteFromBlackAndWhite({ black, white, out });
		for (const [index, pixel] of pixels.entries()) {
			const got = Array.from(out.slice(index * 4, index * 4 + 4));
			expect(Math.abs(got[3] - pixel[3])).toBeLessThanOrEqual(1);
			if (pixel[3] > 32) {
				for (const c of [0, 1, 2]) expect(Math.abs(got[c] - pixel[c])).toBeLessThanOrEqual(4);
			}
		}
	});
});
