import { describe, expect, test, mock } from "bun:test";
mock.module("opencut-wasm", () => ({
	TICKS_PER_SECOND: () => 600000,
	mediaTimeToSeconds: (time: number) => time / 600000,
	mediaTimeFromSeconds: (seconds: number) => seconds * 600000,
	lastFrameTime: () => 0,
	parseTimecode: () => 0,
	roundToFrame: (time: number) => time,
	snappedSeekTime: (time: number) => time,
	formatTimecode: () => "",
}));
const { PreviewInteractionController } =
	await import("./controllers/preview-interaction-controller");
const { TransformHandleController } =
	await import("./controllers/transform-handle-controller");
function fixture() {
	const el = (id: string, x: number) => ({
		id,
		type: "graphic",
		groupId: "g",
		startTime: 0,
		duration: 100,
		params: {
			"transform.positionX": x,
			"transform.positionY": 0,
			"transform.scaleX": 0.1,
			"transform.scaleY": 0.1,
			"transform.rotate": 0,
		},
	});
	const a = el("a", -100),
		b = el("b", 100),
		track = { id: "t", type: "graphic", elements: [a, b] };
	const tracks = {
		overlay: [track],
		main: { id: "m", type: "video", elements: [] },
		audio: [],
	};
	let selected: any[] = [],
		updates: any[] = [],
		commits = 0;
	const viewport = {
		screenToCanvas: ({ clientX, clientY }: any) => ({ x: clientX, y: clientY }),
		screenPixelsToLogicalThreshold: () => ({ x: 0, y: 0 }),
	};
	const scene = {
		getTracks: () => tracks,
		getCurrentTime: () => 0,
		getMediaAssets: () => [],
		getCanvasSize: () => ({ width: 1000, height: 1000 }),
		getSelectedElements: () => selected,
	};
	const timeline = {
		getElementsWithTracks: ({ elements }: any) =>
			elements.map((ref: any) => ({
				track,
				element: [a, b].find((e) => e.id === ref.elementId),
			})),
		previewElements: (v: any[]) => {
			updates = v;
		},
		commitPreview: () => {
			commits++;
		},
		discardPreview: () => {},
	};
	const selection = {
		getSelected: () => selected,
		setSelected: (v: any[]) => {
			selected = v;
		},
		clearSelection: () => {
			selected = [];
		},
	};
	const target = {
		setPointerCapture() {},
		hasPointerCapture: () => true,
		releasePointerCapture() {},
	};
	const event = (x: number, y: number) =>
		({
			clientX: x,
			clientY: y,
			currentTarget: target,
			pointerId: 1,
			button: 0,
			type: "pointerup",
			stopPropagation() {},
		}) as any;
	return {
		viewport,
		scene,
		timeline,
		selection,
		event,
		updates: () => updates,
		commits: () => commits,
	};
}
describe("preview groups", () => {
	test("selects and moves members together, double-click isolates one", () => {
		const f = fixture();
		const c = new PreviewInteractionController({
			depsRef: {
				current: {
					...f,
					input: { isShiftHeld: () => true },
					playback: { getIsPlaying: () => false, subscribe: () => () => {} },
					preview: { isMaskMode: () => false },
				} as any,
			},
		});
		c.onPointerDown(f.event(400, 500));
		c.onPointerUp(f.event(400, 500));
		expect(f.selection.getSelected().map((r) => r.elementId)).toEqual([
			"a",
			"b",
		]);
		c.onPointerDown(f.event(400, 500));
		c.onPointerMove(f.event(430, 520));
		c.onPointerUp(f.event(430, 520));
		expect(
			f.updates().map((u) => u.updates.params["transform.positionX"]),
		).toEqual([-70, 130]);
		expect(f.commits()).toBe(1);
		c.onDoubleClick(f.event(600, 500));
		expect(f.selection.getSelected().map((r) => r.elementId)).toEqual(["b"]);
		c.destroy();
	});
	test("scales and rotates all members around shared bounds", () => {
		const f = fixture();
		f.selection.setSelected([
			{ trackId: "t", elementId: "a" },
			{ trackId: "t", elementId: "b" },
		]);
		const c = new TransformHandleController({
			depsRef: {
				current: {
					...f,
					input: { isShiftHeld: () => true },
					preview: {},
				} as any,
			},
		});
		c.onCornerPointerDown({ event: f.event(650, 550), corner: "bottom-right" });
		c.onPointerMove({ event: f.event(800, 600) });
		expect(
			f.updates().map((u) => u.updates.params["transform.positionX"]),
		).toEqual([-200, 200]);
		expect(
			f.updates().map((u) => u.updates.params["transform.scaleX"]),
		).toEqual([0.2, 0.2]);
		c.onPointerUp();
		expect(f.commits()).toBe(1);
		c.onRotationPointerDown({ event: f.event(500, 400) });
		c.onPointerMove({ event: f.event(600, 500) });
		expect(
			f.updates().map((u) => Math.round(u.updates.params["transform.rotate"])),
		).toEqual([90, 90]);
		c.onPointerUp();
		c.destroy();
	});
});
