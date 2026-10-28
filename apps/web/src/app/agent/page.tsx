"use client";

// Open /agent to load an agent draft (AGENT_WORKSPACE/bundle) as a new OpenCut project.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { importAgentBundle } from "@/agent/importer";

export default function AgentImport() {
	const router = useRouter();
	const [status, setStatus] = useState("");
	const [busy, setBusy] = useState(false);
	const started = useRef(false);
	const run = async () => {
		if (started.current) return;
		started.current = true;
		setBusy(true);
		try {
			const bundlePath = new URLSearchParams(window.location.search).get("bundle") ?? undefined;
			const id = await importAgentBundle({ onStatus: setStatus, bundlePath });
			router.push(`/editor/${id}`);
		} catch (error) {
			setStatus("Failed: " + (error instanceof Error ? error.message : String(error)));
			setBusy(false);
			started.current = false;
		}
	};
	useEffect(() => {
		if (new URLSearchParams(window.location.search).get("auto") === "1") void run();
	}, []);
	return (
		<div className="bg-background flex h-screen w-screen flex-col items-center justify-center gap-4">
			<h1 className="text-2xl font-semibold">Import agent draft</h1>
			<p className="text-muted-foreground max-w-md text-center text-sm">
				Create a new OpenCut project from the latest agent draft. Existing projects are untouched.
			</p>
			<button type="button" disabled={busy} onClick={run} className="bg-primary text-primary-foreground rounded-md px-5 py-2 font-medium disabled:opacity-50">
				{busy ? "Importing…" : "Import draft"}
			</button>
			<p className="text-muted-foreground text-sm">{status}</p>
		</div>
	);
}
