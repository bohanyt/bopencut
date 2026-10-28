import type { ParamValues } from "@/params";
import type { TextElement } from "@/timeline";
import { pickTextStyle, TEXT_STYLE_KEYS } from "./style";
import { resolveAnimationPathValueAtTime } from "@/animation";
import { getBuiltInElementParams } from "@/params/registry";
import { parseColorToLinearRgba } from "@/params";

export interface TextStylePreset {
	name: string;
	style: ParamValues;
}

export function validateTextPreset(value: unknown): TextStylePreset {
	if (
		!value ||
		typeof value !== "object" ||
		!("name" in value) ||
		!("style" in value)
	)
		throw new Error("Preset needs name and style");
	const { name, style } = value;
	if (
		typeof name !== "string" ||
		!name.trim() ||
		name.length > 80 ||
		/[\\/\x00-\x1f]/u.test(name)
	)
		throw new Error("Invalid preset name");
	if (!style || typeof style !== "object" || Array.isArray(style))
		throw new Error("Invalid preset style");
	const entries = Object.entries(style);
	for (const [key, entry] of entries) {
		if (
			!TEXT_STYLE_KEYS.includes(key) ||
			!["number", "string", "boolean"].includes(typeof entry) ||
			(typeof entry === "number" && !Number.isFinite(entry))
		)
			throw new Error(`Invalid style parameter: ${key}`);
		const definition = getBuiltInElementParams({ type: "text" }).find(
			(param) => param.key === key,
		);
		if (
			!definition ||
			typeof entry !== typeof definition.default ||
			(definition.type === "select" &&
				!definition.options.some((option) => option.value === entry)) ||
			(definition.type === "color" &&
				!parseColorToLinearRgba({ color: String(entry) }))
		)
			throw new Error(`Invalid style value: ${key}`);
	}
	return { name: name.trim(), style: Object.fromEntries(entries) };
}

export function createTextPreset(
	name: string,
	element: TextElement,
	localTime = 0,
): TextStylePreset {
	const defaults = Object.fromEntries(
		getBuiltInElementParams({ type: "text" }).map((param) => [
			param.key,
			param.default,
		]),
	);
	const style = Object.fromEntries(
		Object.entries(pickTextStyle({ ...defaults, ...element.params })).map(
			([key, value]) => [
				key,
				resolveAnimationPathValueAtTime({
					animations: element.animations,
					propertyPath: key,
					localTime,
					fallbackValue: value,
				}),
			],
		),
	);
	return validateTextPreset({ name, style });
}

export function applyTextPreset(
	element: TextElement,
	preset: TextStylePreset,
): TextElement {
	const { style } = validateTextPreset(preset);
	// A saved base style replaces animation for the properties it supplies.
	const animations =
		element.animations &&
		Object.fromEntries(
			Object.entries(element.animations).filter(([key]) => !(key in style)),
		);
	return { ...element, params: { ...element.params, ...style }, animations };
}

export async function loadTextPresets(): Promise<TextStylePreset[]> {
	const response = await fetch("/api/agent/presets", { cache: "no-store" });
	if (!response.ok) throw new Error("Could not load text presets");
	const values: unknown = await response.json();
	if (!Array.isArray(values)) throw new Error("Invalid preset list");
	return values.map(validateTextPreset);
}

export async function saveTextPreset(preset: TextStylePreset): Promise<void> {
	const response = await fetch("/api/agent/presets", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(validateTextPreset(preset)),
	});
	if (!response.ok) throw new Error("Could not save text preset");
}
