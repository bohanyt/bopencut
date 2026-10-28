/**
 * The compositor canvas is opaque, so a nested scene is rendered twice (over black and over
 * white) and alpha is recovered from the difference: with normal blending
 * black = C·a and white = C·a + (1 - a), so a = 1 - (white - black) and C = black / a.
 * Writes straight (non-premultiplied) RGBA into `out`, as ImageData expects.
 */
export function matteFromBlackAndWhite({
	black,
	white,
	out,
}: {
	black: Uint8ClampedArray;
	white: Uint8ClampedArray;
	out: Uint8ClampedArray;
}): void {
	for (let i = 0; i < out.length; i += 4) {
		const difference =
			(white[i] - black[i] + white[i + 1] - black[i + 1] + white[i + 2] - black[i + 2]) / 3;
		const alpha = 255 - difference;
		if (alpha <= 0) {
			out[i] = 0;
			out[i + 1] = 0;
			out[i + 2] = 0;
			out[i + 3] = 0;
			continue;
		}
		const scale = 255 / alpha;
		out[i] = black[i] * scale;
		out[i + 1] = black[i + 1] * scale;
		out[i + 2] = black[i + 2] * scale;
		out[i + 3] = alpha;
	}
}
