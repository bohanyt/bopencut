import { describe, expect, test } from "bun:test";
import {
	activeWordIndex,
	distributeWordTimings,
	editCaptionText,
	makeCaption,
	wrapCaptionWords,
} from "./caption";
import {
	resolveTextStyle,
	strokeWidthInPixels,
	textStyleParams,
} from "./style";
import {
	applyTextPreset,
	createTextPreset,
	validateTextPreset,
} from "./presets";
import { buildTextElement } from "@/timeline/element-utils";
import { upsertPathKeyframe } from "@/animation";
import { resolveAnimationTarget } from "@/timeline/animation-targets";
import { type MediaTime, TICKS_PER_SECOND } from "@/wasm";
import type { TextElement } from "@/timeline";

const t = (seconds: number) =>
	Math.round(seconds * TICKS_PER_SECOND) as MediaTime;
const element = (): TextElement => ({
	...buildTextElement({
		raw: { params: { content: "One two three", fontSize: 10 } },
		startTime: t(0),
	}),
	id: "caption",
	duration: t(3),
});

describe("caption word timing", () => {
	test("omitted timings divide duration evenly and use half-open active intervals", () => {
		const caption = distributeWordTimings("One two three", 3);
		expect(caption.approximate).toBe(true);
		expect(caption.words.map(({ start, end }) => [start, end])).toEqual([
			[0, 1],
			[1, 2],
			[2, 3],
		]);
		expect(
			[-1, 0, 0.999, 1, 2.5, 3].map((time) =>
				activeWordIndex(caption.words, time),
			),
		).toEqual([-1, 0, 0, 1, 2, -1]);
		expect(distributeWordTimings("  \n", 3).words).toEqual([]);
	});
	test("validates matching words, gaps, and invalid timing input", () => {
		const words = [
			{ text: "One", start: 0.2, end: 0.8 },
			{ text: "two", start: 1, end: 2 },
		];
		expect(makeCaption("One two", 3, words).approximate).toBe(false);
		expect(activeWordIndex(words, 0.9)).toBe(-1);
		for (const invalid of [
			[{ text: "Other", start: 0, end: 1 }],
			[{ text: "One", start: 0, end: 4 }],
			[{ text: "One", start: NaN, end: 1 }],
		])
			expect(() => makeCaption("One", 3, invalid)).toThrow();
	});
	test("edits preserve matching timings and emphasis, estimate only changed spans", () => {
		const source = makeCaption("One two three", 3, [
			{ text: "One", start: 0, end: 1 },
			{ text: "two", start: 1, end: 2, highlight: true },
			{ text: "three", start: 2, end: 3 },
		]);
		const punctuation = editCaptionText(source, "One, two three!", 3);
		expect(punctuation.approximate).toBe(false);
		expect(punctuation.words[1]).toEqual(source.words[1]);
		const changed = editCaptionText(source, "One new three", 3);
		expect(changed.words[0]).toEqual(source.words[0]);
		expect(changed.words[1]).toEqual({
			text: "new",
			start: 1,
			end: 2,
			approximate: true,
		});
		expect(changed.words[2]).toEqual(source.words[2]);
		expect(
			editCaptionText(source, "One extra two three", 3).words.map(
				({ end }) => end,
			),
		).toEqual([0.75, 1.5, 2.25, 3]);
		expect(
			editCaptionText(source, "Different phrase", 3).words.map(
				({ start, end }) => [start, end],
			),
		).toEqual([
			[0, 1.5],
			[1.5, 3],
		]);
	});
	test("repeated words match in order", () => {
		const source = makeCaption("go go now", 3, [
			{ text: "go", start: 0, end: 1 },
			{ text: "go", start: 1, end: 2 },
			{ text: "now", start: 2, end: 3 },
		]);
		expect(
			editCaptionText(source, "go now", 3).words.map(({ start }) => start),
		).toEqual([0, 2]);
	});
});

test("wrapping respects max width, explicit lines, and the last-line orphan option", () => {
	const measure = (text: string) => text.length;
	expect(wrapCaptionWords("one two six end", 11, false, measure)).toEqual([
		[0, 1, 2],
		[3],
	]);
	expect(wrapCaptionWords("one two six end", 11, true, measure)).toEqual([
		[0, 1],
		[2, 3],
	]);
	expect(wrapCaptionWords("one two six elephant", 11, true, measure)).toEqual([
		[0, 1, 2],
		[3],
	]);
	expect(wrapCaptionWords("one two\nsix end", 100, true, measure)).toEqual([
		[0, 1],
		[2, 3],
	]);
	expect(wrapCaptionWords("one two", 0, true, measure)).toEqual([[0, 1]]);
});

test("stroke radii resolve em and px aliases; numeric style parameters are keyframable", () => {
	expect(strokeWidthInPixels(0.1, 0, 80)).toBe(8);
	expect(strokeWidthInPixels(0.1, 4, 80)).toBe(4);
	expect(strokeWidthInPixels(0.1, 0, 80, true)).toBe(0);
	let el = element();
	for (const param of textStyleParams.filter(
		(param) => param.type === "number",
	))
		expect(
			resolveAnimationTarget({ element: el, path: param.key }),
		).not.toBeNull();
	el.params = {
		...el.params,
		"stroke.inner.width": 0.1,
		"stroke.outer.width": 0.2,
		"shadow.opacity": 0.8,
		"shadow.offsetX": 10,
		"shadow.blur": 4,
	};
	const target = resolveAnimationTarget({
		element: el,
		path: "stroke.inner.width",
	})!;
	el.animations = upsertPathKeyframe({
		animations: undefined,
		propertyPath: "stroke.inner.width",
		time: t(0),
		value: 0.1,
		interpolation: "linear",
		channelLayout: target.channelLayout,
		coerceValue: target.coerceValue,
	});
	el.animations = upsertPathKeyframe({
		animations: el.animations,
		propertyPath: "stroke.inner.width",
		time: t(2),
		value: 0.3,
		interpolation: "linear",
		channelLayout: target.channelLayout,
		coerceValue: target.coerceValue,
	});
	const resolved = resolveTextStyle(el, 100, t(1));
	expect(resolved.strokes.map(({ width }) => width)).toEqual([20, 20]);
	expect(resolved.shadow).toMatchObject({ opacity: 0.8, offsetX: 10, blur: 4 });
});

test("presets save only style and apply without changing content, timings, or placement", () => {
	const el = element();
	el.caption = distributeWordTimings("One two three", 3);
	el.params["transform.positionX"] = 200;
	el.params["stroke.inner.width"] = 0.12;
	const preset = createTextPreset("Readable", el);
	expect(preset.style.content).toBeUndefined();
	expect(preset.style["transform.positionX"]).toBeUndefined();
	const target = {
		...el,
		params: { ...el.params, color: "#ff0000", content: "Keep me" },
	};
	const applied = applyTextPreset(target, JSON.parse(JSON.stringify(preset)));
	expect(applied.params.content).toBe("Keep me");
	expect(applied.params["transform.positionX"]).toBe(200);
	expect(applied.caption).toBe(target.caption);
	expect(applied.params["stroke.inner.width"]).toBe(0.12);
	expect(() => validateTextPreset({ name: "../escape", style: {} })).toThrow();
	expect(() =>
		validateTextPreset({ name: "Invalid", style: { content: "bad" } }),
	).toThrow();
});
