import { expect, test } from "bun:test";
import { cancelInteraction, trackScrub } from "./cancel-interaction";
import { startPresetDurationDrag } from "@/animation/duration-control";

test("a cancelled duration drag ignores movement and release until the next drag", () => {
	const events: string[] = [];
	const start = () => startPresetDurationDrag({
		pointerId: 1,
		onCommit: () => events.push("commit"),
		onDiscard: () => events.push("discard"),
	});
	const drag = start();
	try {
		drag.previewing = true;
		cancelInteraction();
		expect(drag.cancelled).toBe(true);
		drag.finish(true);
		expect(events).toEqual(["discard"]);
	} finally {
		drag.finish(false);
	}

	const next = start();
	try {
		expect(next.cancelled).toBe(false);
		next.previewing = true;
		next.finish(true);
		expect(events).toEqual(["discard", "commit"]);
	} finally {
		next.finish(false);
	}
});

test("cancelling a scrub removes pointer listeners and does not commit on release", () => {
	const events: string[] = [];
	const document = new EventTarget();
	const stop = trackScrub({
		document,
		onMove: () => events.push("preview"),
		onEnd: () => events.push("commit"),
		onStop: () => events.push("unlock"),
	});
	try {
		document.dispatchEvent(new Event("pointermove"));
		cancelInteraction();
		document.dispatchEvent(new Event("pointermove"));
		document.dispatchEvent(new Event("pointerup"));
		expect(events).toEqual(["preview", "unlock"]);
	} finally {
		stop();
	}
});
