"use client";

import { useEffect } from "react";
import { EditorCore } from "@/core";
import { BundleImportError, importAgentBundle, type ImportAssetResult } from "./importer";
import type { ImportRequest } from "./import-queue";

let busy = false;
async function post(endpoint: string, body: unknown) {
	const response = await fetch(`/api/agent/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
	if (!response.ok) throw new Error(await response.text());
	return response.json();
}

export async function pollImports() {
	if (busy) return;
	busy = true;
	try {
		const response = await fetch("/api/agent/imports-request", { cache: "no-store" });
		if (!response.ok) throw new Error(await response.text());
		const request: ImportRequest | null = await response.json();
		if (!request) return;
		const { token } = await post("imports-claim", { id: request.id });
		if (!token) return;
		const assets: ImportAssetResult[] = [];
		let result: Record<string, unknown>;
		try {
			const projectId = await importAgentBundle({ ...request, onStatus: () => {}, onAsset: (asset) => assets.push(asset) });
			result = { status: "done", projectId, assets };
		} catch (error) {
			result = { status: "error", error: String(error), assets: error instanceof BundleImportError ? error.assets : assets };
		}
		await post("imports-result", { id: request.id, token, ...result });
		if (result.status === "done") await EditorCore.getInstance().project.loadAllProjects();
	} catch (error) { console.error("Agent import failed:", error); }
	finally { busy = false; }
}

/** Mounted once at the app root, so projects, import, and editor pages can all consume requests. */
export function AgentImportPoller() {
	useEffect(() => {
		void pollImports();
		const timer = setInterval(pollImports, 2000);
		return () => clearInterval(timer);
	}, []);
	return null;
}
