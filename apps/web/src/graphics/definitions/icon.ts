import type { GraphicDefinition } from "../types";

export const iconGraphicDefinition: GraphicDefinition = {
	id: "icon", name: "Icon", keywords: ["icon"],
	params: [
		{ key: "color", label: "Color", type: "color", default: "#ffffff", keyframable: true },
		{ key: "iconName", label: "Icon", type: "text", default: "" },
		{ key: "svg", label: "SVG", type: "text", default: "" },
	],
	render({ ctx, params, width, height }) {
		if (typeof DOMParser === "undefined") return;
		const doc = new DOMParser().parseFromString(String(params.svg ?? ""), "image/svg+xml");
		const root = doc.documentElement;
		if (root.localName !== "svg") return;
		const box = (root.getAttribute("viewBox") ?? "0 0 24 24").trim().split(/[ ,]+/).map(Number);
		if (box.length !== 4 || !box.every(Number.isFinite) || box[2] <= 0 || box[3] <= 0) return;
		ctx.save();
		ctx.scale(width / box[2], height / box[3]);
		ctx.translate(-box[0], -box[1]);
		const color = String(params.color ?? "#ffffff");
		const renderNode = (node: Element, fill: string, stroke: string) => {
			ctx.save();
			fill = node.getAttribute("fill") ?? fill;
			stroke = node.getAttribute("stroke") ?? stroke;
			const sw = node.getAttribute("stroke-width");
			if (sw !== null) ctx.lineWidth = Number(sw);
			const cap = node.getAttribute("stroke-linecap");
			if (cap === "round" || cap === "butt" || cap === "square") ctx.lineCap = cap;
			const join = node.getAttribute("stroke-linejoin");
			if (join === "round" || join === "miter" || join === "bevel") ctx.lineJoin = join;
			const opacity = node.getAttribute("opacity");
			if (opacity !== null) ctx.globalAlpha *= Math.max(0, Math.min(1, Number(opacity)));
			const transform = node.getAttribute("transform");
			if (transform) {
				try { const m = new DOMMatrix(transform); ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f); } catch { /* Unsupported transform. */ }
			}
			const n = (key: string) => Number(node.getAttribute(key) ?? 0);
			const path = new Path2D();
			try {
				switch (node.localName) {
					case "path": path.addPath(new Path2D(node.getAttribute("d") ?? "")); break;
					case "rect": path.roundRect(n("x"), n("y"), n("width"), n("height"), n("rx")); break;
					case "circle": path.arc(n("cx"), n("cy"), n("r"), 0, Math.PI * 2); break;
					case "ellipse": path.ellipse(n("cx"), n("cy"), n("rx"), n("ry"), 0, 0, Math.PI * 2); break;
					case "line": path.moveTo(n("x1"), n("y1")); path.lineTo(n("x2"), n("y2")); break;
					case "polyline": case "polygon": {
						const points = (node.getAttribute("points") ?? "").trim().split(/[ ,]+/).map(Number);
						if (points.length >= 2) { path.moveTo(points[0], points[1]); for (let i = 2; i + 1 < points.length; i += 2) path.lineTo(points[i], points[i + 1]); }
						if (node.localName === "polygon") path.closePath();
						break;
					}
				}
				if (fill !== "none") { ctx.fillStyle = fill === "currentColor" ? color : fill; ctx.fill(path, node.getAttribute("fill-rule") === "evenodd" ? "evenodd" : "nonzero"); }
				if (stroke !== "none") { ctx.strokeStyle = stroke === "currentColor" ? color : stroke; ctx.stroke(path); }
			} catch { /* Skip malformed geometry. */ }
			for (const child of Array.from(node.children)) renderNode(child, fill, stroke);
			ctx.restore();
		};
		renderNode(root, "black", "none");
		ctx.restore();
	},
};
