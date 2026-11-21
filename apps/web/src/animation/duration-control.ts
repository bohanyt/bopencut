import { MAX_PRESET_SECONDS, MIN_PRESET_SECONDS } from "@/animation/presets";
import { TICKS_PER_SECOND } from "@/wasm";

export function getPresetDurationRange(duration: number) {
	const min = MIN_PRESET_SECONDS;
	const max = Math.max(min, Math.min(MAX_PRESET_SECONDS, duration / TICKS_PER_SECOND));
	return { min, max };
}
