type CancelFn = () => void;

const cancellers = new Set<CancelFn>();

export function registerCanceller({ fn }: { fn: CancelFn }): () => void {
	cancellers.add(fn);

	return () => {
		cancellers.delete(fn);
	};
}

export function registerPointerCanceller({
	target,
	pointerId,
	onCancel,
}: {
	target: Pick<HTMLElement, "hasPointerCapture" | "releasePointerCapture">;
	pointerId: number;
	onCancel: () => void;
}): () => void {
	return registerCanceller({
		fn: () => {
			// Clear the gesture before lost pointer capture can finish it.
			onCancel();
			if (target.hasPointerCapture(pointerId)) {
				target.releasePointerCapture(pointerId);
			}
		},
	});
}

export function cancelInteraction(): boolean {
	if (cancellers.size === 0) return false;

	const activeCancellers = Array.from(cancellers);
	cancellers.clear();

	for (const cancel of activeCancellers) {
		cancel();
	}

	return true;
}
