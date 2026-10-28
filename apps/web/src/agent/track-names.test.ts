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
