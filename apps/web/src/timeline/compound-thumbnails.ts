import type { EditorCore } from "@/core";
import type { CompoundElement, TScene } from "@/timeline";
import { calculateTotalDuration } from "@/timeline";
import { collectCompoundScenes } from "@/timeline/compound";
import type { MediaTime } from "@/wasm";

// Thumbnail strips of compound clips on the timeline: a few low-res renders of the nested
// content, cached by content and rendered one at a time, only while playback is paused.

export const COMPOUND_THUMBNAIL_COUNT = 5;
const THUMBNAIL_HEIGHT_PX = 54;
const CACHE_LIMIT = 64;
const SETTLE_DELAY_MS = 400;

/** Nested times at the middle of `count` equal slots of the clip's visible window. */
export function getCompoundThumbnailTimes({
	element,
	count = COMPOUND_THUMBNAIL_COUNT,
}: {
	element: Pick<CompoundElement, "trimStart" | "duration">;
	count?: number;
}): MediaTime[] {
	const slot = element.duration / count;
	return Array.from(
		{ length: count },
		(_, index) => Math.round(element.trimStart + slot * (index + 0.5)) as MediaTime,
	);
}

const objectTokens = new WeakMap<object, number>();
let nextToken = 1;

function tokenOf(value: object): number {
	let token = objectTokens.get(value);
	if (token === undefined) {
		token = nextToken++;
		objectTokens.set(value, token);
	}
	return token;
}

/**
 * Cache key of a clip's strip. Tracks are immutable, so the identity of the nested scene's tracks
 * and of every scene it reaches changes exactly when the content does (edits at any depth
 * invalidate, unrelated scenes do not, and an undo brings the old strip back). The visible
 * window, canvas, and media list are part of it too.
 */
export function getCompoundThumbnailKey({
	scenes,
	element,
	canvasSize,
	mediaAssets,
}: {
	scenes: TScene[];
	element: CompoundElement;
	canvasSize: { width: number; height: number };
	mediaAssets: object;
}): string {
	const reached = collectCompoundScenes({ scenes, elements: [element] })
		.map((scene) => tokenOf(scene.tracks))
		.sort((a, b) => a - b);
	return [
		element.sceneId,
		reached.join("."),
		element.trimStart,
		element.duration,
		`${canvasSize.width}x${canvasSize.height}`,
		tokenOf(mediaAssets),
	].join("|");
}

type RenderFrames = () => Promise<string[]>;

/** Rendered strips by key (least recently used dropped first) and the queue that fills them. */
export class CompoundThumbnailCache {
	private frames = new Map<string, string[]>();
	private queue = new Map<string, RenderFrames>();
	private listeners = new Set<() => void>();
	private running = false;

	constructor(
		private options: {
			/** Rendering waits while this is true (e.g. during playback). */
			isBusy: () => boolean;
			wait: (ms: number) => Promise<void>;
			limit?: number;
		},
	) {}

	get(key: string): string[] | undefined {
		const frames = this.frames.get(key);
		if (frames) {
			this.frames.delete(key);
			this.frames.set(key, frames);
		}
		return frames;
	}

	/** Queues a render unless the key is cached or queued; the newest request renders first. */
	request(key: string, render: RenderFrames): void {
		if (this.frames.has(key) || this.queue.has(key)) return;
		this.queue.set(key, render);
		void this.drain();
	}

	/** Drops queued renders no clip shows any more (e.g. stale keys after an edit). */
	cancel(key: string): void {
		this.queue.delete(key);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async drain(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			while (this.queue.size > 0) {
				// Let a burst of edits settle, and never compete with playback for the compositor.
				await this.options.wait(SETTLE_DELAY_MS);
				const newest = [...this.queue.entries()].at(-1);
				if (!newest || this.options.isBusy()) continue;
				const [key, render] = newest;
				this.queue.delete(key);
				try {
					this.store(key, await render());
				} catch (error) {
					console.warn("Compound thumbnail render failed:", error);
				}
			}
		} finally {
			this.running = false;
		}
	}

	private store(key: string, frames: string[]): void {
		this.frames.set(key, frames);
		const limit = this.options.limit ?? CACHE_LIMIT;
		while (this.frames.size > limit) {
			const oldest = this.frames.keys().next().value as string;
			this.frames.delete(oldest);
		}
		for (const listener of this.listeners) listener();
	}
}

/** Low-res frames of the nested scene at `times`, as JPEG data URLs. */
export async function renderCompoundThumbnails({
	editor,
	element,
}: {
	editor: EditorCore;
	element: CompoundElement;
}): Promise<string[]> {
	const [{ buildScene }, { CanvasRenderer }] = await Promise.all([
		import("@/services/renderer/scene-builder"),
		import("@/services/renderer/canvas-renderer"),
	]);
	const project = editor.project.getActive();
	const scenes = editor.scenes.getScenes();
	const nested = scenes.find((scene) => scene.id === element.sceneId);
	if (!nested) return [];
	const { canvasSize, fps, background } = project.settings;
	const duration = calculateTotalDuration({ tracks: nested.tracks });
	const tree = buildScene({
		tracks: nested.tracks,
		mediaAssets: editor.media.getAssets(),
		duration: duration || 1,
		canvasSize,
		background,
		scenes,
	});
	const renderer = new CanvasRenderer({
		width: canvasSize.width,
		height: canvasSize.height,
		fps,
		renderScale: Math.min(1, THUMBNAIL_HEIGHT_PX / canvasSize.height),
	});
	const canvas = document.createElement("canvas");
	canvas.width = renderer.outputWidth;
	canvas.height = renderer.outputHeight;
	const frames: string[] = [];
	for (const time of getCompoundThumbnailTimes({ element })) {
		await renderer.renderToCanvas({
			node: tree,
			time: Math.min(time, Math.max(0, duration - 1)),
			targetCanvas: canvas,
		});
		frames.push(canvas.toDataURL("image/jpeg", 0.7));
	}
	return frames;
}

let sharedCache: CompoundThumbnailCache | null = null;

export function getCompoundThumbnailCache({
	editor,
}: {
	editor: EditorCore;
}): CompoundThumbnailCache {
	sharedCache ??= new CompoundThumbnailCache({
		isBusy: () => editor.playback.getIsPlaying(),
		wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	});
	return sharedCache;
}
