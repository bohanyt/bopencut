import { describe, expect, test } from "bun:test";
import { validNote } from "./notes";

describe("notes", () => {
	test("accepts valid points and ranges", () => {
		expect(validNote("catatan", 0, undefined)).toBe(true);
		expect(validNote("catatan", 1.25, 2.5)).toBe(true);
	});
	test("rejects empty text and invalid times", () => {
		for (const [text, start, end] of [[" ", 0, undefined], ["a", -1, undefined], ["a", 2, 1], ["a", NaN, undefined], ["a", 0, Infinity]]) expect(validNote(text, start, end)).toBe(false);
	});
});
