import { describe, expect, test } from "bun:test";
import { model3dState } from "./state";

describe("model3dState", () => {
	test("converts degrees and preserves deterministic camera and light", () => {
		const params = { rotationX: 90, rotationY: 360, rotationZ: -180, cameraDistance: 4, cameraFov: 60, lightX: -2 };
		const first = model3dState(params);
		expect(first.rotation[0]).toBeCloseTo(Math.PI / 2);
		expect(first.rotation[1]).toBeCloseTo(2 * Math.PI);
		expect(first.rotation[2]).toBeCloseTo(-Math.PI);
		expect(first.distance).toBe(4);
		expect(first.fov).toBe(60);
		expect(first.light[0]).toBe(-2);
		expect(model3dState(params)).toEqual(first);
	});
	test("uses safe defaults and clamps invalid camera values", () => {
		const result = model3dState({ cameraFov: 200, cameraDistance: -1, modelScale: 0, rotationX: NaN });
		expect(result.fov).toBe(150);
		expect(result.distance).toBe(0.1);
		expect(result.scale).toBe(0.01);
		expect(result.rotation[0]).toBe(0);
	});
});
