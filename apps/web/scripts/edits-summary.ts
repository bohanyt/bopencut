import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { summarizeEdits } from "../src/agent/edits-summary";
import type { EditLine } from "../src/agent/edit-log";

const args = process.argv.slice(2);
const workspaces = args.filter((arg) => arg !== "--json");
if (!workspaces.length) { console.error("Pakai: bun apps/web/scripts/edits-summary.ts <workspace> [workspace...] [--json]"); process.exit(1); }
const lines: EditLine[] = [];
for (const workspace of workspaces) {
	const dir = path.join(workspace, "edits");
	let files: string[];
	try { files = await readdir(dir); } catch (error: any) { if (error.code === "ENOENT") continue; throw error; }
	for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
		const text = await readFile(path.join(dir, file), "utf8");
		for (const [index, line] of text.split(/\r?\n/).entries()) if (line.trim()) {
			try { lines.push(JSON.parse(line)); } catch { throw new Error(`${path.join(dir, file)}:${index + 1}: JSON tidak valid`); }
		}
	}
}
const summary = summarizeEdits(lines);
if (args.includes("--json")) console.log(JSON.stringify(summary, null, 2));
else {
	console.log("# Ringkasan edit\n");
	for (const p of summary) console.log(`- **${p.track} / ${p.elementType} / ${p.field}**: ${p.count} kali, ${p.projects} proyek; median delta ${p.medianDelta ?? "?"}; dari ? ke ${JSON.stringify(p.typical[0])} ? ${JSON.stringify(p.typical[1])}${p.kandidatAturan ? " ? kandidat aturan" : ""}`);
}
