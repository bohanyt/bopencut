import { z } from "zod";
import type { Bundle } from "./importer";

const params = z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.number().finite())]));
const asset = z.object({ path: z.string().min(1), name: z.string().min(1), type: z.enum(["image", "video", "audio", "model"]) });
const track = z.object({ name: z.string().min(1), type: z.enum(["video", "audio", "effect", "graphic", "text"]).optional(), index: z.number().int().nonnegative().optional() });
const element: z.ZodType = z.lazy(() => z.object({
	agent_id: z.string().optional(), name: z.string(), start: z.number().finite().nonnegative(),
	duration: z.number().finite().positive().optional(), trimStart: z.number().finite().nonnegative().optional(),
	asset: z.union([z.string().min(1), asset]).optional(),
	text: z.string().optional(), group: z.string().optional(), params: params.optional(),
	size: z.tuple([z.number().finite().positive(), z.number().finite().positive()]).optional(),
	fit: z.enum(["contain", "cover", "width"]).optional(),
	graphic: z.object({ definitionId: z.string().min(1), params: params.optional() }).optional(),
	icon: z.object({ name: z.string().min(1), color: z.string().optional(), svg: z.string().optional() }).optional(),
	effect: z.string().optional(), effectParams: z.record(z.string(), z.number().finite()).optional(),
	model3d: z.object({ params: z.record(z.string(), z.number().finite()).optional() }).optional(),
	keyframes: z.array(z.object({ path: z.string(), time: z.number().finite().nonnegative(), value: z.number().finite() })).optional(),
	compound: content.optional(), track: track.optional(),
}).passthrough().superRefine((e, ctx) => {
	if (!e.compound && e.duration === undefined) ctx.addIssue({ code: "custom", message: "Non-compound elements need duration" });
	if ([e.asset, e.text, e.graphic, e.icon, e.effect, e.compound].filter((v) => v !== undefined).length !== 1) ctx.addIssue({ code: "custom", message: "Element needs exactly one asset, text, graphic, icon, effect, or compound" });
}));
const overlay = z.array(z.object({ name: z.string(), type: z.enum(["video", "effect", "graphic", "text"]), elements: z.array(element) }));
const content = z.object({ main: z.array(element).optional(), audio: z.array(element).optional(), overlay: overlay.optional(), elements: z.array(element).optional() });
const schema = content.extend({
	// Older producers used arbitrary schema strings; keep accepting those layouts.
	schema: z.string().optional(), name: z.string().min(1), width: z.number().int().positive().max(16384), height: z.number().int().positive().max(16384),
	assets: z.array(asset.extend({ key: z.string().min(1) })),
	fonts: z.array(z.object({ family: z.string().min(1), path: z.string().min(1), weight: z.string().optional(), style: z.enum(["normal", "italic", "oblique"]).optional() })).optional(),
});

export function validateBundle(value: unknown): Bundle {
	const parsed = schema.parse(value);
	const keys = new Set<string>();
	for (const a of parsed.assets) {
		if (keys.has(a.key)) throw new Error(`Duplicate asset key: ${a.key}`);
		keys.add(a.key);
	}
	const check = (content: Record<string, unknown>): void => {
		const list = [...(content.main as Record<string, unknown>[] ?? []), ...(content.audio as Record<string, unknown>[] ?? []), ...(content.elements as Record<string, unknown>[] ?? []),
			...(content.overlay as { elements: Record<string, unknown>[] }[] ?? []).flatMap((t) => t.elements)];
		for (const e of list) {
			if (typeof e.asset === "string" && !keys.has(e.asset)) throw new Error(`Unknown asset key: ${e.asset}`);
			if (e.compound) check(e.compound as Record<string, unknown>);
		}
	};
	check(parsed);
	return parsed as Bundle;
}
