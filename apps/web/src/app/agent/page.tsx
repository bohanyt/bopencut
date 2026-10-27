"use client";

// Buka /agent untuk memuat draf agen (AGENT_WORKSPACE/bundle) sebagai proyek OpenCut baru.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { importAgentBundle } from "@/agent/importer";

export default function AgentImport() {
	const router = useRouter();
	const [status, setStatus] = useState("");
	const [busy, setBusy] = useState(false);
	const run = async () => {
		setBusy(true);
		try {
			const id = await importAgentBundle({ onStatus: setStatus });
			router.push(`/editor/${id}`);
		} catch (error) {
			setStatus("Gagal: " + (error instanceof Error ? error.message : String(error)));
			setBusy(false);
		}
	};
	return (
		<div className="bg-background flex h-screen w-screen flex-col items-center justify-center gap-4">
			<h1 className="text-2xl font-semibold">Impor draf agen</h1>
			<p className="text-muted-foreground max-w-md text-center text-sm">
				Membuat proyek OpenCut baru dari draf terbaru agen. Proyek lama tidak disentuh.
			</p>
			<button type="button" disabled={busy} onClick={run} className="bg-primary text-primary-foreground rounded-md px-5 py-2 font-medium disabled:opacity-50">
				{busy ? "Mengimpor…" : "Impor draf"}
			</button>
			<p className="text-muted-foreground text-sm">{status}</p>
		</div>
	);
}
