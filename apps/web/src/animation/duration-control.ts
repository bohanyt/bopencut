import { MAX_PRESET_SECONDS, MIN_PRESET_SECONDS } from "@/animation/presets";
import { TICKS_PER_SECOND } from "@/wasm";
import { registerCanceller } from "@/editor/cancel-interaction";

export function getPresetDurationRange(duration: number) {
	const min = MIN_PRESET_SECONDS;
	const max = Math.max(min, Math.min(MAX_PRESET_SECONDS, duration / TICKS_PER_SECOND));
	return { min, max };
}

export function startPresetDurationDrag({
	pointerId,
	onCommit,
	onDiscard,
}: {
	pointerId: number;
	onCommit: () => void;
	onDiscard: () => void;
}) {
	const drag = {
		pointerId,
		previewing: false,
		cancelled: false,
		finish(commit: boolean) {
			unregister();
			if (!drag.previewing) return;
			drag.previewing = false;
			if (commit) onCommit();
			else onDiscard();
		},
	};
	const unregister = registerCanceller({
		fn: () => {
			drag.cancelled = true;
			drag.finish(false);
		},
	});
	return drag;
}
