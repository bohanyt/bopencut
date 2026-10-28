export type ProjectFont = { family: string; dataUrl: string; weight?: string; style?: string };
const localFaces = new Map<string, FontFace[]>();
export const hasProjectFont = (family: string) => localFaces.has(family);

export async function validateProjectFont(font: ProjectFont): Promise<FontFace> {
	const face = new FontFace(font.family, `url("${font.dataUrl}")`, { weight: font.weight ?? "normal", style: font.style ?? "normal" });
	return face.load();
}

/** The file bytes travel with the project; no workspace or network dependency on reopen. */
export async function loadProjectFonts(fonts: ProjectFont[], environment?: {
	create: typeof validateProjectFont; registry: { add(face: FontFace): void; delete(face: FontFace): unknown };
}) {
	if (!fonts.length && !localFaces.size) return;
	const { create, registry } = environment ?? { create: validateProjectFont, registry: document.fonts };
	const loaded = await Promise.all(fonts.map(create));
	for (const faces of localFaces.values()) for (const face of faces) registry.delete(face);
	localFaces.clear();
	for (const [i, face] of loaded.entries()) {
		registry.add(face);
		const family = fonts[i].family;
		localFaces.set(family, [...(localFaces.get(family) ?? []), face]);
	}
}
