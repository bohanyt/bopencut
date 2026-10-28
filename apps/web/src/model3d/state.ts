import type { ParamValues } from "@/params";

export function model3dState(params: ParamValues) {
	const value = (key: string, fallback: number) => {
		const n = params[key];
		return typeof n === "number" && Number.isFinite(n) ? n : fallback;
	};
	const radians = (degrees: number) => degrees * Math.PI / 180;
	return {
		rotation: [radians(value("rotationX", 0)), radians(value("rotationY", 0)), radians(value("rotationZ", 0))] as const,
		scale: Math.max(0.01, value("modelScale", 1)),
		distance: Math.max(0.1, value("cameraDistance", 3.5)),
		fov: Math.max(5, Math.min(150, value("cameraFov", 45))),
		intensity: Math.max(0, value("lightIntensity", 2)),
		light: [value("lightX", 3), value("lightY", 4), value("lightZ", 5)] as const,
	};
}
