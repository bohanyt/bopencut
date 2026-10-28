import { describe, expect, test } from "bun:test";
import { progressDash } from "../definitions/strokes";
import { iconUrl } from "@/stickers/providers/iconify";

describe("stroke reveal", () => {
	test("clamps progress to the stroke length", () => {
		expect(progressDash(100, 0, 0)).toEqual([0, 101]);
		expect(progressDash(100, 0.5, 0)).toEqual([50, 101]);
		expect(progressDash(100, 2, 0)).toEqual([100, 101]);
	});
	test("preserves dashes up to the reveal boundary", () => {
		expect(progressDash(100, 0.25, 10)).toEqual([10, 10, 5, 101]);
		expect(progressDash(100, 0.2, 10)).toEqual([10, 10, 0, 101]);
	});
});

describe("icon URLs", () => {
	test("uses only an Iconify prefix and name", () => {
		expect(iconUrl("lucide:server")).toBe("https://api.iconify.design/lucide/server.svg");
		expect(() => iconUrl("../../x:y")).toThrow();
	});
});
