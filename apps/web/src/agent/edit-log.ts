// Diff completed snapshots, not every drag frame.
export type EditItem = { id: string; agentId: string | null; name: string; media: string | null; type: string; track: string; startTime: number; duration: number; trimStart: number; trimEnd: number; params: Record<string, unknown>; animations: Record<string, unknown> };
export type EditSnapshot = { projectId: string; items: EditItem[] };
export type EditLine = { t: string; projectId: string; actor: "user"; kind: "set" | "delete" | "add"; agentId: string | null; elementId: string; name: string; track: string; elementType: string; field: string; from: unknown; to: unknown };

export function diffEdits(before: EditSnapshot | null, after: EditSnapshot, t = new Date().toISOString()): EditLine[] {
	if (!before || before.projectId !== after.projectId) return [];
	const old = new Map(before.items.map((item) => [item.id, item]));
	const next = new Map(after.items.map((item) => [item.id, item]));
	const lines: EditLine[] = [];
	const add = (item: EditItem, kind: EditLine["kind"], field: string, from: unknown, to: unknown) => {
		if (JSON.stringify(from) === JSON.stringify(to)) return;
		lines.push({ t, projectId: after.projectId, actor: "user", kind, agentId: item.agentId, elementId: item.id, name: item.media ?? item.name, track: item.track, elementType: item.type, field, from: from ?? null, to: to ?? null });
	};
	for (const item of before.items) if (item.agentId && !next.has(item.id)) add(item, "delete", "element", { startTime: item.startTime, duration: item.duration }, null);
	for (const item of after.items) {
		const prev = old.get(item.id);
		if (!prev) { if (!item.agentId) add(item, "add", "element", null, { startTime: item.startTime, duration: item.duration }); continue; }
		for (const field of ["startTime", "duration", "trimStart", "trimEnd", "track"] as const) add(item, "set", field, prev[field], item[field]);
		for (const key of new Set([...Object.keys(prev.params), ...Object.keys(item.params)])) add(item, "set", key, prev.params[key], item.params[key]);
		for (const key of new Set([...Object.keys(prev.animations), ...Object.keys(item.animations)])) add(item, "set", `keyframes.${key}`, prev.animations[key], item.animations[key]);
	}
	return lines;
}

export function createEditLogger(capture: () => EditSnapshot | null, preview: () => boolean, send: (lines: EditLine[]) => void) {
	let baseline = capture();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let suppressed = false;
	const settle = () => {
		if (suppressed) return;
		if (preview()) { timer = setTimeout(settle, 800); return; }
		const current = capture();
		if (current) { const lines = diffEdits(baseline, current); baseline = current; if (lines.length) send(lines); }
		else baseline = null;
	};
	return {
		changed() { if (!suppressed) { clearTimeout(timer); timer = setTimeout(settle, 800); } },
		agent(action: () => void) { clearTimeout(timer); settle(); suppressed = true; try { action(); } finally { baseline = capture(); suppressed = false; } },
	};
}
