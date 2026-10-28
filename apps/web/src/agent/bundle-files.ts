import { readJson, resolveAgentFile } from "./workspace-files";
import { validateBundle } from "./bundle-schema";
import type { AgentElement } from "./elements";
import path from "node:path";

export async function readAgentBundle(bundlePath: string, workspace: string, filesRoot: string) {
	const requested = /\.json$/i.test(bundlePath) ? bundlePath : path.join(bundlePath, "bundle.json");
	const full = await resolveAgentFile(requested, workspace, filesRoot);
	const bundle = validateBundle(await readJson(full));
	const failures: { key: string; path: string; ok: boolean; error?: string }[] = [];
	const resolve = async (asset: { path: string }, key: string) => {
		try {
			// Existing asset paths remain root-relative (files root first), not bundle-relative.
			asset.path = await resolveAgentFile(asset.path, filesRoot, workspace);
			failures.push({ key, path: asset.path, ok: true });
		} catch (error) { failures.push({ key, path: asset.path, ok: false, error: String(error) }); }
	};
	for (const asset of bundle.assets) await resolve(asset, asset.key);
	const walk = async (elements: AgentElement[]) => {
		for (const e of elements) {
			if (e.asset && typeof e.asset !== "string") await resolve(e.asset, e.agent_id ?? e.name);
			if (e.compound) await walk([...(e.compound.main ?? []), ...(e.compound.audio ?? []), ...(e.compound.overlay ?? []).flatMap((t) => t.elements), ...(e.compound.elements ?? [])]);
		}
	};
	await walk([...(bundle.main ?? []), ...(bundle.audio ?? []), ...(bundle.overlay ?? []).flatMap((t) => t.elements)]);
	for (const font of bundle.fonts ?? []) await resolve(font, `font:${font.family}`);
	if (failures.some((a) => !a.ok)) return { ok: false as const, error: "Bundle files are missing or inaccessible", assets: failures };
	return { ok: true as const, bundle, assets: failures };
}
