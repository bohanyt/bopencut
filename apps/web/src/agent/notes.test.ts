import { describe, expect, test } from "bun:test";
import { validNote } from "./notes";

describe("catatan", () => {
	test("menerima titik dan rentang yang valid", () => {
		expect(validNote("catatan", 0, undefined)).toBe(true);
		expect(validNote("catatan", 1.25, 2.5)).toBe(true);
	});
	test("menolak teks kosong dan waktu tidak valid", () => {
		for (const [text, start, end] of [[" ", 0, undefined], ["a", -1, undefined], ["a", 2, 1], ["a", NaN, undefined], ["a", 0, Infinity]]) expect(validNote(text, start, end)).toBe(false);
	});
});
