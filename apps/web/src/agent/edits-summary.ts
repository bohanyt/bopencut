import type { EditLine } from "./edit-log";

export function summarizeEdits(lines: EditLine[]) {
	const groups = new Map<string, EditLine[]>();
	for (const line of lines) {
		const field = line.kind === "set" ? line.field : line.kind;
		const key = JSON.stringify([line.track, line.elementType, field]);
		groups.set(key, [...(groups.get(key) ?? []), line]);
	}
	return [...groups.entries()].map(([key, entries]) => {
		const [track, elementType, field] = JSON.parse(key) as string[];
		const deltas = entries.filter((e) => typeof e.from === "number" && typeof e.to === "number").map((e) => (e.to as number) - (e.from as number)).sort((a, b) => a - b);
		const median = (values: number[]) => values.length ? (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2 : null;
		const pairs = new Map<string, number>();
		for (const e of entries) { const pair = JSON.stringify([e.from, e.to]); pairs.set(pair, (pairs.get(pair) ?? 0) + 1); }
		const typical = JSON.parse([...pairs.entries()].sort((a, b) => b[1] - a[1])[0][0]);
		return { track, elementType, field, count: entries.length, projects: new Set(entries.map((e) => e.projectId)).size, medianDelta: median(deltas), typical, kandidatAturan: entries.length >= 3 };
	}).sort((a, b) => a.track.localeCompare(b.track) || a.elementType.localeCompare(b.elementType) || a.field.localeCompare(b.field));
}
