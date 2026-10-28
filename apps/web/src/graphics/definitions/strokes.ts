import type { ParamDefinition } from "@/params";
import type { GraphicDefinition, GraphicRenderContext } from "../types";

const common: ParamDefinition[] = [
	{
		key: "stroke",
		label: "Color",
		type: "color",
		default: "#ffffff",
		group: "stroke",
	},
	{
		key: "strokeWidth",
		label: "Width",
		type: "number",
		default: 4,
		min: 0,
		max: 64,
		step: 1,
		group: "stroke",
	},
	{
		key: "lineCap",
		label: "Cap",
		type: "select",
		default: "round",
		options: [
			{ value: "butt", label: "Butt" },
			{ value: "round", label: "Round" },
			{ value: "square", label: "Square" },
		],
	},
	{
		key: "dash",
		label: "Dash length",
		type: "number",
		default: 0,
		min: 0,
		max: 100,
		step: 1,
	},
	{
		key: "drawProgress",
		label: "Draw progress",
		type: "number",
		default: 1,
		min: 0,
		max: 1,
		step: 0.01,
		keyframable: true,
	},
];

/** Build a dash pattern that ends at the requested distance along a stroke. */
export function progressDash(
	length: number,
	progress: number,
	dash: number,
): number[] {
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

function strokePath(
	{ ctx, params, width, height }: GraphicRenderContext,
	d: string,
	length: number,
) {
	const progress = Math.min(1, Math.max(0, Number(params.drawProgress ?? 1)));
	if (!progress || !Number.isFinite(length) || length <= 0) return;
	ctx.save();
	ctx.scale(width / 100, height / 100);
	ctx.strokeStyle = String(params.stroke ?? "#ffffff");
	ctx.lineWidth =
		(Math.max(0, Number(params.strokeWidth ?? 4)) * 100) /
		Math.min(width, height);
	ctx.lineCap = (params.lineCap ?? "round") as CanvasLineCap;
	const dash =
		(Math.max(0, Number(params.dash ?? 0)) * 100) / Math.min(width, height);
	ctx.setLineDash(progressDash(length, progress, dash));
	try {
		ctx.stroke(new Path2D(d));
	} catch {
		/* Invalid SVG path. */
	}
	ctx.restore();
}

export function parseViewBox(
	value: string,
): [number, number, number, number] | null {
	const values = value.trim().split(/[ ,]+/).map(Number);
	return values.length === 4 &&
		values.every(Number.isFinite) &&
		values[2] > 0 &&
		values[3] > 0
		? (values as [number, number, number, number])
		: null;
}

export function viewBoxTransform(
	box: readonly [number, number, number, number],
	width: number,
	height: number,
) {
	return {
		scaleX: width / box[2],
		scaleY: height / box[3],
		translateX: -box[0],
		translateY: -box[1],
	};
}

export function splitSubpaths(d: string): string[] {
	return d
		.split(/(?=[Mm])/)
		.map((part) => part.trim())
		.filter(Boolean);
}

export function subpathProgress(lengths: number[], progress: number): number[] {
	let remaining =
		lengths.reduce((sum, length) => sum + length, 0) *
		Math.max(0, Math.min(1, progress));
	return lengths.map((length) => {
		const visible = Math.max(0, Math.min(length, remaining));
		remaining -= visible;
		return visible;
	});
}

function measurePath(d: string) {
	const parts = splitSubpaths(d);
	const paths: Array<{ d: string; length: number }> = [];
	let prefix = "";
	for (const part of parts) {
		let absolutePart = part;
		if (part.startsWith("m") && prefix) {
			const previous = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"path",
			);
			previous.setAttribute("d", prefix);
			const point = previous.getPointAtLength(previous.getTotalLength());
			absolutePart = `M ${point.x} ${point.y} ${part}`;
		}
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", absolutePart);
		paths.push({ d: absolutePart, length: path.getTotalLength() });
		prefix += ` ${part}`;
	}
	return paths;
}

export const lineGraphicDefinition: GraphicDefinition = {
	id: "line",
	name: "Line",
	keywords: ["line", "stroke"],
	params: common,
	render(context) {
		strokePath(context, "M 2 50 L 98 50", 96);
	},
};

export const arrowGraphicDefinition: GraphicDefinition = {
	id: "arrow",
	name: "Arrow",
	keywords: ["arrow", "connector"],
	params: [
		...common,
		{ key: "headFill", label: "Head fill", type: "color", default: "#00000000" },
		{
			key: "headSize",
			label: "Head size",
			type: "number",
			default: 16,
			min: 1,
			max: 48,
			step: 1,
		},
		{
			key: "headStyle",
			label: "Head style",
			type: "select",
			default: "open",
			options: [
				{ value: "open", label: "Open" },
				{ value: "triangle", label: "Triangle" },
			],
		},
	],
	render(context) {
		const size = Math.min(
			48,
			Math.max(1, Number(context.params.headSize ?? 16)),
		);
		const triangle = context.params.headStyle === "triangle";
		const d = `M 2 50 L 98 50 L ${98 - size} ${50 - size / 2}${triangle ? ` L ${98 - size} ${50 + size / 2}` : ` L 98 50 L ${98 - size} ${50 + size / 2}`}`;
		strokePath(
			context,
			d,
			96 +
				(triangle ? 1 : 3) * Math.hypot(size, size / 2) +
				(triangle ? size : 0),
		);
		if (triangle && Number(context.params.drawProgress ?? 1) >= 0.999) {
			const { ctx, width, height, params } = context;
			ctx.save();
			ctx.scale(width / 100, height / 100);
			ctx.fillStyle = String(params.headFill ?? "#00000000");
			ctx.fill(new Path2D(`M 98 50 L ${98-size} ${50-size/2} L ${98-size} ${50+size/2} Z`));
			ctx.restore();
		}
	},
};

export const pathGraphicDefinition: GraphicDefinition = {
	id: "path",
	name: "Path",
	keywords: ["path", "svg", "curve"],
	params: [
		...common,
		{ key: "d", label: "SVG path", type: "text", default: "M 2 50 L 98 50" },
		{ key: "viewBox", label: "View box", type: "text", default: "" },
		{ key: "fill", label: "Fill", type: "color", default: "#00000000" },
	],
	render({ ctx, params, width, height }) {
		if (typeof document === "undefined") return;
		const d = String(params.d ?? "");
		try {
			const paths = measurePath(d);
			const svgPath = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"path",
			);
			svgPath.setAttribute("d", d);
			let box = parseViewBox(String(params.viewBox ?? ""));
			if (!box) {
				const svg = document.createElementNS(
					"http://www.w3.org/2000/svg",
					"svg",
				);
				svg.style.cssText =
					"position:absolute;visibility:hidden;pointer-events:none";
				svg.appendChild(svgPath);
				document.body.appendChild(svg);
				try {
					const bounds = svgPath.getBBox();
					box = [
						bounds.x - (bounds.width ? 0 : 0.5),
						bounds.y - (bounds.height ? 0 : 0.5),
						bounds.width || 1,
						bounds.height || 1,
					];
				} finally {
					svg.remove();
				}
			}
			const visible = subpathProgress(
				paths.map((path) => path.length),
				Number(params.drawProgress ?? 1),
			);
			ctx.save();
			const transform = viewBoxTransform(box, width, height);
			ctx.scale(transform.scaleX, transform.scaleY);
			ctx.translate(transform.translateX, transform.translateY);
			// Fill the complete compound path, so holes use the SVG winding rule.
			// Reveal the fill with progress while the stroke is drawn by length.
			ctx.save();
			ctx.globalAlpha *= Math.max(0, Math.min(1, Number(params.drawProgress ?? 1)));
			ctx.fillStyle = String(params.fill ?? "#00000000");
			ctx.fill(new Path2D(d));
			ctx.restore();
			ctx.strokeStyle = String(params.stroke ?? "#ffffff");
			ctx.lineWidth =
				Math.max(0, Number(params.strokeWidth ?? 4)) *
				Math.min(box[2] / width, box[3] / height);
			ctx.lineCap = (params.lineCap ?? "round") as CanvasLineCap;
			const dash =
				Math.max(0, Number(params.dash ?? 0)) *
				Math.min(box[2] / width, box[3] / height);
			paths.forEach((path, i) => {
				if (visible[i] <= 0 || path.length <= 0 || Number(params.strokeWidth ?? 4) <= 0) return;
				ctx.setLineDash(
					progressDash(path.length, visible[i] / path.length, dash),
				);
				ctx.stroke(new Path2D(path.d));
			});
			ctx.restore();
		} catch {
			/* Invalid SVG path. */
		}
	},
};
