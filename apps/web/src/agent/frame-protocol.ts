import type { TProjectSettings } from "@/project/types";
import type { TScene } from "@/timeline";

export const requestIdPattern = /^[a-zA-Z0-9_-]{1,100}$/;
export type FrameRequest = {
	id: string; projectId: string; times: number[]; width?: number;
	snapshotHash?: string; rev?: string; legacy?: boolean;
};
export type FrameStatus = {
	id: string; projectId: string; status: "queued" | "running" | "done" | "error" | "stale";
	done: number; total: number; files: string[];
	errors: { index: number; time: number; error: string }[];
	snapshotHash?: string; rev?: string; error?: string; updatedAt?: string;
};

export function validateFrameRequest(value: unknown, id: string): FrameRequest {
	if (!requestIdPattern.test(id) || !value || typeof value !== "object") throw new Error("Invalid frame request");
	const r = value as Record<string, unknown>;
	if (typeof r.projectId !== "string" || !requestIdPattern.test(r.projectId)) throw new Error("projectId is required for frames v2");
	if (!Array.isArray(r.times) || !r.times.length || r.times.some((t) => typeof t !== "number" || !Number.isFinite(t) || t < 0)) throw new Error("times must contain finite nonnegative seconds");
	if (r.width !== undefined && (!Number.isInteger(r.width) || Number(r.width) < 1 || Number(r.width) > 4096)) throw new Error("width must be an integer from 1 to 4096");
	for (const key of ["snapshotHash", "rev"]) if (r[key] !== undefined && typeof r[key] !== "string") throw new Error(`${key} must be a string`);
	return { id, projectId: r.projectId, times: r.times, width: r.width as number | undefined, snapshotHash: r.snapshotHash as string | undefined, rev: r.rev as string | undefined };
}

/** A deterministic content fingerprint, not a security hash. Dates and open-scene navigation are excluded. */
export function frameRevision(scenes: TScene[], rootId: string, settings: TProjectSettings) {
	const reachable = new Set<string>();
	const visit = (id: string) => {
		if (reachable.has(id)) return;
		reachable.add(id);
		const scene = scenes.find((s) => s.id === id);
		for (const track of scene ? [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio] : []) {
			for (const e of track.elements) if (e.type === "compound") visit(e.sceneId);
		}
	};
	visit(rootId);
	const canonical = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(canonical);
		if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
		return value;
	};
	const text = JSON.stringify(canonical({
		rootId, settings,
		scenes: scenes.filter((s) => reachable.has(s.id)).map((s) => ({ id: s.id, tracks: s.tracks })).sort((a, b) => a.id.localeCompare(b.id)),
	}));
	let a = 0x811c9dc5, b = 0x9e3779b9;
	for (let i = 0; i < text.length; i++) {
		a = Math.imul(a ^ text.charCodeAt(i), 0x01000193);
		b = Math.imul(b ^ text.charCodeAt(i), 0x85ebca6b);
	}
	const snapshotHash = `timeline-${(a >>> 0).toString(16).padStart(8, "0")}${(b >>> 0).toString(16).padStart(8, "0")}`;
	return { snapshotHash, rev: snapshotHash };
}

export function expectsDifferentTimeline(request: FrameRequest, hash: string) {
	return (request.snapshotHash !== undefined && request.snapshotHash !== hash)
		|| (!request.legacy && request.rev !== undefined && request.rev !== hash);
}
