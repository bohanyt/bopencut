import { MAIN_TRACK_NAME } from "@/timeline/placement/main-track";

/** Names that all mean the main track: the agent's "Main", the legacy "Utama", and the editor default "Main Track". */
const MAIN_ALIASES = ["Main", "Utama", MAIN_TRACK_NAME];

/** Track by exact name and type first; for a main-track name, any of its aliases (saved names are never changed). */
export function findTrackByName<T extends { name: string; type: string }>(
	tracks: T[], name: string, type: string,
): T | undefined {
	const exact = tracks.find((track) => track.name === name && track.type === type);
	if (exact || !MAIN_ALIASES.includes(name)) return exact;
	for (const alias of MAIN_ALIASES) {
		if (alias === name) continue;
		const found = tracks.find((track) => track.name === alias && track.type === type);
		if (found) return found;
	}
	return undefined;
}
