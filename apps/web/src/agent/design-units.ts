import type { ParamValues } from "@/params";
import { DEFAULT_GRAPHIC_SOURCE_SIZE } from "@/graphics/types";

export function mediaFitScale(size: [number, number], source: { width: number; height: number }, canvas: { width: number; height: number }, fit: "width" | "contain" | "cover" = "width") {
	if (!["width", "contain", "cover"].includes(fit)) throw new Error("Unknown fit mode");
	if (size.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error("size needs two positive pixel dimensions");
	const x = size[0] / source.width, y = size[1] / source.height;
	const scale = fit === "contain" ? Math.min(x, y) : fit === "cover" ? Math.max(x, y) : x;
	return scale / Math.min(canvas.width / source.width, canvas.height / source.height);
}

/** Pixel aliases win over native values, then disappear from stored params. */
export function convertDesignUnits(params: ParamValues, canvas: { width: number; height: number }, kind: "text" | string) {
	const take = (key: string) => {
		const value = params[key];
		if (value === undefined) return undefined;
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${key} must be a nonnegative pixel value`);
		delete params[key];
		return value;
	};
	const font = take("fontSizePx"), stroke = take("strokeWidthPx"), corner = take("cornerRadiusPx");
	if (font !== undefined) {
		if (kind !== "text" || font <= 0) throw new Error("fontSizePx requires text and a positive value");
		params.fontSize = font * 90 / canvas.height;
	}
	if (stroke === undefined && corner === undefined) return;
	if (kind === "text") throw new Error("strokeWidthPx and cornerRadiusPx apply to graphics");
	const scale = Math.min(canvas.width, canvas.height) / DEFAULT_GRAPHIC_SOURCE_SIZE
		* Math.min(Math.abs(Number(params["transform.scaleX"] ?? 1)), Math.abs(Number(params["transform.scaleY"] ?? 1)));
	if (scale <= 0 || !Number.isFinite(scale)) throw new Error("Pixel graphic units require a nonzero finite scale");
	if (stroke !== undefined) params.strokeWidth = stroke / scale;
	if (corner !== undefined) {
		if (kind !== "rectangle" && kind !== "polygon") throw new Error("cornerRadiusPx requires a rectangle or polygon");
		const inset = (params.strokeAlign ?? "center") === "center" ? Number(params.strokeWidth ?? 0) / 2 : 0;
		const radius = Math.max(1, DEFAULT_GRAPHIC_SOURCE_SIZE / 2 - inset);
		const sides = Math.max(3, Math.min(12, Math.round(Number(params.sides ?? 5))));
		const maximum = (kind === "polygon" ? radius * Math.sin(Math.PI / sides) : radius) * scale;
		params.cornerRadius = Math.min(50, corner * 50 / maximum);
	}
}
