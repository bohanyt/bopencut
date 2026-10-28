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
 * window, canvas, project background, and media list are part of it too.
 */
export function getCompoundThumbnailKey({
	scenes,
	element,
	canvasSize,
	background,
	mediaAssets,
}: {
	scenes: TScene[];
	element: CompoundElement;
	canvasSize: { width: number; height: number };
	background: unknown;
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
		JSON.stringify(background),
		tokenOf(mediaAssets),
	].join("|");
}

/** Renders a strip; returns null when it stopped early because `shouldStop` turned true. */
type RenderFrames = (control: { shouldStop: () => boolean }) => Promise<string[] | null>;

/** Rendered strips by key (least recently used dropped first) and the queue that fills them. */
export class CompoundThumbnailCache {
	private frames = new Map<string, string[]>();
	private queue = new Map<string, RenderFrames>();
	private listeners = new Set<() => void>();
	private running = false;
	private active: { key: string; cancelled: boolean } | null = null;

	constructor(
		private options: {
			/** Rendering waits, and a running strip suspends, while this is true (playback). */
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

	/** Queues a render unless the key is cached, queued, or rendering; the newest renders first. */
	request(key: string, render: RenderFrames): void {
		if (this.active?.key === key) {
			this.active.cancelled = false;
			return;
		}
		if (this.frames.has(key) || this.queue.has(key)) return;
		this.queue.set(key, render);
		void this.drain();
	}

	/** Drops renders no clip shows any more (e.g. stale keys after an edit), even a running one. */
	cancel(key: string): void {
		this.queue.delete(key);
		if (this.active?.key === key) this.active.cancelled = true;
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
				const job = { key, cancelled: false };
				this.active = job;
				try {
					// Checked between frames too: playback that starts mid-strip suspends it.
					const frames = await render({
						shouldStop: () => job.cancelled || this.options.isBusy(),
					});
					if (frames) {
						this.store(key, frames);
					} else if (!job.cancelled && !this.queue.has(key)) {
						// Suspended by playback: resume once it pauses.
						this.queue.set(key, render);
					}
				} catch (error) {
					console.warn("Compound thumbnail render failed:", error);
				} finally {
					this.active = null;
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

/** Renders single low-res frames of one nested scene. */
export interface ThumbnailFrameRenderer {
	renderAt(time: MediaTime): Promise<string>;
}

export type LoadThumbnailRenderer = (params: {
	editor: EditorCore;
	nested: TScene;
	scenes: TScene[];
	/** Covers every sample, so a sample in an empty tail renders what is there: nothing. */
	duration: MediaTime;
}) => Promise<ThumbnailFrameRenderer>;

const loadCanvasThumbnailRenderer: LoadThumbnailRenderer = async ({
	editor,
	nested,
	scenes,
	duration,
}) => {
	const [{ buildScene }, { CanvasRenderer }] = await Promise.all([
		import("@/services/renderer/scene-builder"),
		import("@/services/renderer/canvas-renderer"),
	]);
	const { canvasSize, fps, background } = editor.project.getActive().settings;
	const tree = buildScene({
		tracks: nested.tracks,
		mediaAssets: editor.media.getAssets(),
		duration,
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
	return {
		async renderAt(time) {
			await renderer.renderToCanvas({ node: tree, time, targetCanvas: canvas });
			return canvas.toDataURL("image/jpeg", 0.7);
		},
	};
};

/**
 * Low-res frames of the clip's visible window, as JPEG data URLs. Samples render at their own
 * nested times, including the empty tail left after nested content got shorter. Returns null as
 * soon as `shouldStop` is true (checked before each frame), so playback never waits on a strip.
 */
export async function renderCompoundThumbnails({
	editor,
	element,
	shouldStop = () => false,
	loadRenderer = loadCanvasThumbnailRenderer,
}: {
	editor: EditorCore;
	element: CompoundElement;
	shouldStop?: () => boolean;
	loadRenderer?: LoadThumbnailRenderer;
}): Promise<string[] | null> {
	const scenes = editor.scenes.getScenes();
	const nested = scenes.find((scene) => scene.id === element.sceneId);
	if (!nested) return [];
	const times = getCompoundThumbnailTimes({ element });
	const contentDuration = calculateTotalDuration({ tracks: nested.tracks });
	const duration = Math.max(contentDuration, ...times.map((time) => time + 1)) as MediaTime;
	if (shouldStop()) return null;
	const renderer = await loadRenderer({ editor, nested, scenes, duration });
	const frames: string[] = [];
	for (const time of times) {
		if (shouldStop()) return null;
		frames.push(await renderer.renderAt(time));
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
