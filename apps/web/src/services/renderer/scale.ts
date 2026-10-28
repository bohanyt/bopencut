import type { QuadTransformDescriptor } from "./compositor/types";

export function renderTargetSize({
	width,
	height,
	scale,
}: {
	width: number;
	height: number;
	scale: number;
}) {
	return {
		width: Math.max(1, Math.round(width * scale)),
		height: Math.max(1, Math.round(height * scale)),
	};
}

export function scaleQuad({
	transform,
	width,
	height,
	targetWidth,
	targetHeight,
}: {
	transform: QuadTransformDescriptor;
	width: number;
	height: number;
	targetWidth: number;
	targetHeight: number;
}): QuadTransformDescriptor {
	return {
		...transform,
		centerX: (transform.centerX * targetWidth) / width,
		centerY: (transform.centerY * targetHeight) / height,
		width: (transform.width * targetWidth) / width,
		height: (transform.height * targetHeight) / height,
	};
}
