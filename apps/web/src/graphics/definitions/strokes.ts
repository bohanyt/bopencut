import type { ParamDefinition } from "@/params";
import type { GraphicDefinition, GraphicRenderContext } from "../types";

const common: ParamDefinition[] = [
	{ key: "stroke", label: "Color", type: "color", default: "#ffffff", group: "stroke" },
	{ key: "strokeWidth", label: "Width", type: "number", default: 4, min: 0, max: 64, step: 1, group: "stroke" },
	{ key: "lineCap", label: "Cap", type: "select", default: "round", options: [
		{ value: "butt", label: "Butt" }, { value: "round", label: "Round" }, { value: "square", label: "Square" },
	] },
	{ key: "dash", label: "Dash length", type: "number", default: 0, min: 0, max: 100, step: 1 },
	{ key: "drawProgress", label: "Draw progress", type: "number", default: 1, min: 0, max: 1, step: 0.01, keyframable: true },
];

/** Build a dash pattern that ends at the requested distance along a stroke. */
export function progressDash(length: number, progress: number, dash: number): number[] {
	const visible = Math.max(0, length) * Math.min(1, Math.max(0, progress));
	if (visible <= 0) return [0, Math.max(1, length + 1)];
	if (dash <= 0) return [visible, Math.max(1, length + 1)];
	const result: number[] = [];
	let remaining = visible;
	let on = true;
	while (remaining > 0 && result.length < 10000) {
		const segment = Math.min(dash, remaining);
		result.push(segment);
		remaining -= segment;
		on = !on;
	}
	if (on) result.push(0);
	result.push(Math.max(1, length + 1));
	return result;
}

function strokePath({ ctx, params, width, height }: GraphicRenderContext, d: string, length: number) {
	const progress = Math.min(1, Math.max(0, Number(params.drawProgress ?? 1)));
	if (!progress || !Number.isFinite(length) || length <= 0) return;
	ctx.save();
	ctx.scale(width / 100, height / 100);
	ctx.strokeStyle = String(params.stroke ?? "#ffffff");
	ctx.lineWidth = Math.max(0, Number(params.strokeWidth ?? 4)) * 100 / Math.min(width, height);
	ctx.lineCap = (params.lineCap ?? "round") as CanvasLineCap;
	const dash = Math.max(0, Number(params.dash ?? 0)) * 100 / Math.min(width, height);
	ctx.setLineDash(progressDash(length, progress, dash));
	try { ctx.stroke(new Path2D(d)); } catch { /* Invalid SVG path. */ }
	ctx.restore();
}

function pathLength(d: string): number {
	if (typeof document === "undefined") return 0;
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
	path.setAttribute("d", d);
	try { return path.getTotalLength(); } catch { return 0; }
}

export const lineGraphicDefinition: GraphicDefinition = {
	id: "line", name: "Line", keywords: ["line", "stroke"], params: common,
	render(context) { strokePath(context, "M 2 50 L 98 50", 96); },
};

export const arrowGraphicDefinition: GraphicDefinition = {
	id: "arrow", name: "Arrow", keywords: ["arrow", "connector"],
	params: [...common,
		{ key: "headSize", label: "Head size", type: "number", default: 16, min: 1, max: 48, step: 1 },
		{ key: "headStyle", label: "Head style", type: "select", default: "open", options: [
			{ value: "open", label: "Open" }, { value: "triangle", label: "Triangle" },
		] },
	],
	render(context) {
		const size = Math.min(48, Math.max(1, Number(context.params.headSize ?? 16)));
		const triangle = context.params.headStyle === "triangle";
		const d = `M 2 50 L 98 50 L ${98 - size} ${50 - size / 2}${triangle ? ` L ${98 - size} ${50 + size / 2}` : ` L 98 50 L ${98 - size} ${50 + size / 2}`}`;
		strokePath(context, d, 96 + (triangle ? 1 : 3) * Math.hypot(size, size / 2) + (triangle ? size : 0));
	},
};

export const pathGraphicDefinition: GraphicDefinition = {
	id: "path", name: "Path", keywords: ["path", "svg", "curve"],
	params: [...common, { key: "d", label: "SVG path (0–100)", type: "text", default: "M 2 50 L 98 50" }],
	render(context) {
		const d = String(context.params.d ?? "");
		strokePath(context, d, pathLength(d));
	},
};
