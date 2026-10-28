export function validNote(text: unknown, start: unknown, end: unknown): boolean {
	return typeof text === "string" && !!text.trim() && typeof start === "number" && Number.isFinite(start) && start >= 0 && (end === undefined || (typeof end === "number" && Number.isFinite(end) && end >= start));
}
