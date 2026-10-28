// Compatibility and diagnostics only. Draft transactions and commands remain in draft.ts.
import type { Draft, DraftOp } from "./draft";
import type { TScene, TimelineElement } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { getElementBounds, getCornerPosition, type ElementBounds } from "@/preview/element-bounds";

type MakeCompound = Omit<Extract<DraftOp, { op: "group" }>, "op"> & { op: "make-compound" };
export type ProtocolDraft = Omit<Draft, "ops"> & { ops: (DraftOp | MakeCompound)[] };
export function normalizeDraftOps(ops: ProtocolDraft["ops"]): DraftOp[] {
	return structuredClone(ops).map((op) => op.op === "make-compound" ? { ...op, op: "group" } : op);
}

export function visibleBoundsFraction(bounds: ElementBounds, canvas: { width: number; height: number }) {
	let polygon = (["top-left", "top-right", "bottom-right", "bottom-left"] as const).map((corner) => getCornerPosition({ bounds, corner }));
	for (const [axis, edge, sign] of [["x", 0, 1], ["x", canvas.width, -1], ["y", 0, 1], ["y", canvas.height, -1]] as const) {
		const input = polygon;
		polygon = [];
		for (let i = 0; i < input.length; i++) {
			const a = input[i], b = input[(i + 1) % input.length];
			const aInside = (a[axis] - edge) * sign >= 0, bInside = (b[axis] - edge) * sign >= 0;
			if (aInside) polygon.push(a);
			if (aInside !== bInside) {
				const t = (edge - a[axis]) / (b[axis] - a[axis]);
				polygon.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
			}
		}
	}
	const area = Math.abs(polygon.reduce((sum, a, i) => { const b = polygon[(i + 1) % polygon.length]; return sum + a.x * b.y - b.x * a.y; }, 0)) / 2;
	return area / Math.max(1, Math.abs(bounds.width * bounds.height));
}

export function withBoundsWarnings(results: Record<string, unknown>[], scenes: TScene[], canvas: { width: number; height: number }, media: MediaAsset[], ops: ProtocolDraft["ops"]) {
	return results.map((result, index) => {
		const warnings: { code: string; sceneId: string; id: string; visibleFraction: number; message: string }[] = [];
		const refs = [result.element, result.compound, ...(Array.isArray(result.elements) ? result.elements : [])];
		const seen = new Set<string>();
		if (result.ok) for (const ref of refs) {
			if (!ref || typeof ref !== "object" || !("id" in ref) || !("sceneId" in ref)) continue;
			const key = `${ref.sceneId}:${ref.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const scene = scenes.find((s) => s.id === ref.sceneId);
			const element = scene && [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio].flatMap((t): TimelineElement[] => t.elements).find((e) => e.id === ref.id);
			if (!element || (element.type === "text" && typeof document === "undefined")) continue;
			const bounds = getElementBounds({ element, canvasSize: canvas, localTime: 0, mediaAsset: "mediaId" in element ? media.find((m) => m.id === element.mediaId) : undefined });
			if (!bounds) continue;
			const visibleFraction = visibleBoundsFraction(bounds, canvas);
			if (visibleFraction < 0.25) warnings.push({ code: "mostly-off-canvas", sceneId: scene!.id, id: element.id, visibleFraction, message: "Less than 25% of this element's initial bounds is on its scene canvas." });
		}
		return { ...result, op: ops[index]?.op ?? result.op, ...(warnings.length ? { warnings } : {}) };
	});
}
