import { expect, test } from "bun:test";
import type { ProjectFont } from "./project-fonts";
const { hasProjectFont, loadProjectFonts } = await import("./project-fonts");
const { loadFullFont } = await import("./google-fonts");

test("embedded project fonts reload without a network request and replace previous project faces", async () => {
	const faces = new Set<FontFace>();
	const sources: string[] = [];
	const environment = {
		create: async (font: ProjectFont) => { sources.push(font.dataUrl); return { family: font.family } as FontFace; },
		registry: { add: (face: FontFace) => { faces.add(face); }, delete: (face: FontFace) => faces.delete(face) },
	};
	try {
		const saved: ProjectFont[] = JSON.parse(JSON.stringify([{ family: "Embedded Test", dataUrl: "data:font/woff2;base64,AAAA" }]));
		await loadProjectFonts(saved, environment);
		// No document exists in this test: reaching the network-font loader would fail.
		await loadFullFont({ family: "Embedded Test" });
		expect(hasProjectFont("Embedded Test")).toBe(true);
		expect(sources[0]).toContain("data:font/woff2;base64,AAAA");
		expect(faces.size).toBe(1);
		await loadProjectFonts(saved, environment);
		expect(faces.size).toBe(1);
		await loadProjectFonts([], environment);
		expect(faces.size).toBe(0);
		expect(hasProjectFont("Embedded Test")).toBe(false);
	} finally { await loadProjectFonts([], environment); }
});
