import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { GET, POST } from "@/app/api/agent/presets/route";
import { applyTextPreset, validateTextPreset } from "./presets";
import { buildTextElement } from "@/timeline/element-utils";
import { ZERO_MEDIA_TIME } from "@/wasm";

test("workspace preset API saves, reloads, replaces and applies a named style", async () => {
	const workspace = await fs.mkdtemp(
		path.join(os.tmpdir(), "caption-presets-"),
	);
	const previous = process.env.AGENT_WORKSPACE;
	process.env.AGENT_WORKSPACE = workspace;
	try {
		const save = (style: Record<string, string | number>) =>
			POST(
				new Request("http://localhost/api/agent/presets", {
					method: "POST",
					body: JSON.stringify({ name: "Readable", style }),
				}),
			);
		expect(
			(await save({ fontSize: 8, "stroke.inner.width": 0.1 })).status,
		).toBe(200);
		expect(
			(await save({ fontSize: 10, "stroke.inner.width": 0.2 })).status,
		).toBe(200);
		const list = await (await GET()).json();
		expect(list).toHaveLength(1);
		const preset = validateTextPreset(list[0]);
		const element = {
			...buildTextElement({
				raw: { params: { content: "Still editable" } },
				startTime: ZERO_MEDIA_TIME,
			}),
			id: "text",
		};
		expect(applyTextPreset(element, preset).params).toMatchObject({
			content: "Still editable",
			fontSize: 10,
			"stroke.inner.width": 0.2,
		});
		expect((await save({ fontSize: "wrong type" })).status).toBe(400);
	} finally {
		if (previous === undefined) delete process.env.AGENT_WORKSPACE;
		else process.env.AGENT_WORKSPACE = previous;
		await fs.rm(workspace, { recursive: true, force: true });
	}
});
