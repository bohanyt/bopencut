export function findTrackByName<T extends { name: string; type: string }>(
	tracks: T[], name: string, type: string,
): T | undefined {
	const exact = tracks.find((track) => track.name === name && track.type === type);
	if (exact) return exact;
	const alias = name === "Main" ? "Utama" : name === "Utama" ? "Main" : name;
	return tracks.find((track) => track.name === alias && track.type === type);
}
