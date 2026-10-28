import type { FrameRate } from "opencut-wasm";
import type { AnyBaseNode } from "./nodes/base-node";
import { renderTargetSize } from "./scale";
import { buildFrameDescriptor } from "./compositor/frame-descriptor";
import { wasmCompositor } from "./compositor/wasm-compositor";
import { resolveRenderTree } from "./resolve";
import {
	measureSpanAsync,
	measureSpanSync,
	onRenderPerfFrameComplete,
} from "@/diagnostics/render-perf";

export type CanvasRendererParams = {
	width: number;
	height: number;
	fps: FrameRate;
	/** Preview target scale; project coordinates remain unchanged. */
	renderScale?: number;
};

// The WASM compositor and its textures are shared by all renderers.
let renderQueue: Promise<void> = Promise.resolve();

export class CanvasRenderer {
	width: number;
	height: number;
	fps: FrameRate;
	renderScale: number;
	outputWidth: number;
	outputHeight: number;
	private outputCanvas: HTMLCanvasElement;

	constructor({ width, height, fps, renderScale = 1 }: CanvasRendererParams) {
		this.width = width;
		this.height = height;
		this.fps = fps;
		this.renderScale = renderScale;
		const target = renderTargetSize({ width, height, scale: renderScale });
		this.outputWidth = target.width;
		this.outputHeight = target.height;
		this.outputCanvas = document.createElement("canvas");
		this.outputCanvas.width = this.outputWidth;
		this.outputCanvas.height = this.outputHeight;
	}

	getOutputCanvas(): HTMLCanvasElement {
		return this.outputCanvas;
	}

	async render({ node, time }: { node: AnyBaseNode; time: number }) {
		return this.renderToCanvas({ node, time, targetCanvas: this.outputCanvas });
	}

	private async renderFrame({
		node,
		time,
	}: {
		node: AnyBaseNode;
		time: number;
	}) {
		await measureSpanAsync({
			name: "resolve",
			fn: () => resolveRenderTree({ node, renderer: this, time }),
		});
		const { frame, textures } = await measureSpanAsync({
			name: "buildFrame",
			fn: () => buildFrameDescriptor({ node, renderer: this }),
		});
		wasmCompositor.ensureInitialized({
			width: this.outputWidth,
			height: this.outputHeight,
		});
		measureSpanSync({
			name: "syncTextures",
			fn: () => wasmCompositor.syncTextures(textures),
		});
		measureSpanSync({
			name: "renderFrame",
			fn: () => wasmCompositor.render(frame),
		});
	}

	async renderToCanvas({
		node,
		time,
		targetCanvas,
	}: {
		node: AnyBaseNode;
		time: number;
		targetCanvas: HTMLCanvasElement;
	}) {
		const task = renderQueue.then(async () => {
			await this.renderFrame({ node, time });

			const ctx = targetCanvas.getContext("2d");
			if (!ctx) {
				throw new Error("Failed to get target canvas context");
			}

			measureSpanSync({
				name: "drawImage",
				fn: () =>
					ctx.drawImage(
						wasmCompositor.getCanvas(),
						0,
						0,
						targetCanvas.width,
						targetCanvas.height,
					),
			});
			onRenderPerfFrameComplete();
		});
		renderQueue = task.catch(() => {});
		return task;
	}
}
