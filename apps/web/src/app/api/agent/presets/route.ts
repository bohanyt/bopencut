import { promises as fs } from "node:fs";
import path from "node:path";
import { validateTextPreset } from "@/text/presets";

const directory = () =>
	path.join(
		path.resolve(
			process.env.AGENT_WORKSPACE ??
				path.join(process.cwd(), "..", "..", "workspace"),
		),
		"presets",
	);

export async function GET() {
	await fs.mkdir(directory(), { recursive: true });
	const files = (await fs.readdir(directory()))
		.filter((file) => file.endsWith(".json"))
		.sort();
	try {
		const presets = await Promise.all(
			files.map(async (file) =>
				validateTextPreset(
					JSON.parse(await fs.readFile(path.join(directory(), file), "utf8")),
				),
			),
		);
		return Response.json(presets, { headers: { "Cache-Control": "no-store" } });
	} catch {
		return Response.json(
			{ error: "Invalid text preset in workspace" },
			{ status: 400 },
		);
	}
}

export async function POST(request: Request) {
	const origin = request.headers.get("origin");
	if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/u.test(origin))
		return Response.json({ error: "Origin not allowed" }, { status: 403 });
	try {
		const preset = validateTextPreset(await request.json());
		await fs.mkdir(directory(), { recursive: true });
		const file = path.join(
			directory(),
			`${encodeURIComponent(preset.name)}.json`,
		);
		const temporary = `${file}.${crypto.randomUUID()}.tmp`;
		await fs.writeFile(temporary, JSON.stringify(preset, null, 2));
		await fs.rename(temporary, file);
		return Response.json(preset);
	} catch (error) {
		return Response.json(
			{
				error: error instanceof Error ? error.message : "Could not save preset",
			},
			{ status: 400 },
		);
	}
}
