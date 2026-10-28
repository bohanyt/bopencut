import { describe, expect, test } from "bun:test";
import { findTrackByName } from "./track-names";

describe("track name aliases", () => {
	test("matches legacy and English names in both directions", () => {
		const legacy = { name: "Utama", type: "video" };
		const current = { name: "Main", type: "video" };
		expect(findTrackByName([legacy], "Main", "video")).toBe(legacy);
		expect(findTrackByName([current], "Utama", "video")).toBe(current);
		expect(findTrackByName([legacy, current], "Main", "video")).toBe(current);
		expect(findTrackByName([legacy], "Main", "audio")).toBeUndefined();
		expect(findTrackByName([legacy], "Other", "video")).toBeUndefined();
	});
});

describe("main track alias includes the default main track name", () => {
	test("Main, Utama, and Main Track find each other; an exact name wins", () => {
		const ui = { name: "Main Track", type: "video" };
		const exact = { name: "Main", type: "video" };
		expect(findTrackByName([ui], "Main", "video")).toBe(ui);
		expect(findTrackByName([ui], "Utama", "video")).toBe(ui);
		expect(findTrackByName([exact], "Main Track", "video")).toBe(exact);
		expect(findTrackByName([ui, exact], "Main", "video")).toBe(exact);
		expect(findTrackByName([ui], "Main", "audio")).toBeUndefined();
	});
});
