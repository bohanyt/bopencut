import { afterEach, describe, expect, mock, test } from "bun:test";
import type { CompoundElement, TScene, TimelineElement } from "@/timeline";
import type { TProject } from "@/project/types";
import {
	allElements,
	allTracks,
	findCompound,
	fixture,
	getHost,
	refs,
	scene,
	t,
	text,
} from "./compound-fixtures";

// Same GPU stubs as the other command tests (EditorCore pulls the renderer in).
mock.module("@/services/renderer/compositor/wasm-compositor", () => ({ wasmCompositor: {} }));
mock.module("@/services/renderer/gpu-renderer", () => ({
	gpuRenderer: {},
	initializeGpuRenderer: async () => {},
	isGpuAvailable: () => false,
}));
const { EditorCore } = await import("@/core");
const { getDefaultShortcuts } = await import("@/actions");
const { v7ToV8 } = await import("@/actions/keybindings/migrations/v7-to-v8");
const { getNextCompoundName, deepCopyCompoundElements } = await import("@/timeline/compound");
const { getCompoundPath } = await import("@/timeline/compound-navigation");
const { CompoundThumbnailCache, getCompoundThumbnailKey, getCompoundThumbnailTimes } =
	await import("@/timeline/compound-thumbnails");

function setup(scenes: TScene[] = fixture()) {
	EditorCore.reset();
	const editor = EditorCore.getInstance();
	editor.save.stop();
	editor.save.pause();
	editor.project.setActiveProject({
		project: {
			metadata: { id: "p", name: "p", createdAt: new Date(0), updatedAt: new Date(0) },
			scenes,
			currentSceneId: "main",
			settings: { fps: { numerator: 30, denominator: 1 }, canvasSize: { width: 1920, height: 1080 } },
		} as unknown as TProject,
	});
	editor.scenes.setScenes({ scenes, activeSceneId: "main" });
	return editor;
}

type Editor = ReturnType<typeof setup>;

function sceneById(editor: Editor, sceneId: string): TScene {
	const found = editor.scenes.getScenes().find((s) => s.id === sceneId);
	if (!found) throw new Error(`missing scene ${sceneId}`);
	return found;
}

function compoundsIn(target: TScene): CompoundElement[] {
	return allElements(allTracks(target.tracks)).filter(
		(e): e is CompoundElement => e.type === "compound",
	);
}

function refOf(target: TScene, elementId: string) {
	const track = allTracks(target.tracks).find((tr) => tr.elements.some((e) => e.id === elementId));
	if (!track) throw new Error(`missing element ${elementId}`);
	return { trackId: track.id, elementId };
}

/** Main → "Compound clip 1" (title, box, music) → "Compound clip 2" (title). */
async function nestedTwoDeep(editor: Editor) {
	const outer = editor.timeline.createCompound({ elements: refs });
	await editor.scenes.enterCompound(outer.compound);
	const inner = editor.timeline.createCompound({
		elements: [refOf(editor.scenes.getActiveScene(), "title")],
	});
	await editor.scenes.switchToScene({ sceneId: "main" });
	return { outer, inner };
}

/** Ids of every scene, track, and element reachable from `sceneId`, in order. */
function idTree(editor: Editor, sceneId: string): string[] {
	const target = sceneById(editor, sceneId);
	return [
		target.id,
		...allTracks(target.tracks).flatMap((track) => [
			track.id,
			...track.elements.flatMap((e) =>
				e.type === "compound" ? [e.id, ...idTree(editor, e.sceneId)] : [e.id],
			),
		]),
	];
}

afterEach(() => {
	EditorCore.reset();
});

describe("compound clip UI: create, rename, shortcuts", () => {
	test("Alt+G / Alt+Shift+G are the defaults and are added to stored keybindings without overriding", () => {
		const defaults = getDefaultShortcuts();
		expect(defaults.get("alt+g")).toBe("create-compound");
		expect(defaults.get("alt+shift+g")).toBe("break-apart-compound");
		// Preview grouping keeps Ctrl+G / Ctrl+Shift+G (handled by the preview context menu).
		expect(defaults.get("ctrl+g")).toBeUndefined();

		const migrated = v7ToV8({
			state: { keybindings: { "alt+shift+g": "split", s: "split" }, isCustomized: true },
		}) as { keybindings: Record<string, string> };
		expect(migrated.keybindings["alt+g"]).toBe("create-compound");
		expect(migrated.keybindings["alt+shift+g"]).toBe("split");
	});

	test("default names count up: Compound clip 1, 2, ...", () => {
		const editor = setup();
		expect(getNextCompoundName({ scenes: editor.scenes.getScenes() })).toBe("Compound clip 1");
		const first = editor.timeline.createCompound({ elements: [refs[0]] });
		const second = editor.timeline.createCompound({ elements: [refs[1]] });
		expect(sceneById(editor, first.sceneId).name).toBe("Compound clip 1");
		expect(sceneById(editor, second.sceneId).name).toBe("Compound clip 2");
		expect(compoundsIn(getHost(editor.scenes.getScenes())).map((c) => c.name)).toEqual([
			"Compound clip 1",
			"Compound clip 2",
		]);
	});

	test("rename changes the nested scene and every clip showing it, as one undo step", () => {
		const editor = setup();
		const { compound, sceneId } = editor.timeline.createCompound({ elements: refs });
		editor.selection.setSelectedElements({ elements: [compound] });

		editor.timeline.renameCompound({ sceneId, name: "Intro" });
		expect(sceneById(editor, sceneId).name).toBe("Intro");
		expect(findCompound(editor.scenes.getScenes()).name).toBe("Intro");
		// Renaming keeps the clip selected (the properties panel stays open).
		expect(editor.selection.getSelectedElements()).toEqual([compound]);

		editor.command.undo();
		expect(sceneById(editor, sceneId).name).toBe("Compound clip 1");
		expect(findCompound(editor.scenes.getScenes()).name).toBe("Compound clip 1");
	});
});

describe("compound clip UI: enter, exit, breadcrumb", () => {
	test("enter lands on the same frame inside; exit returns to the parent at its playhead", async () => {
		const editor = setup();
		const { compound, sceneId } = editor.timeline.createCompound({ elements: refs });
		editor.playback.seek({ time: t(3) }); // clip spans 1..5 → nested 2
		await editor.scenes.enterCompound(compound);

		expect(editor.scenes.getActiveScene().id).toBe(sceneId);
		expect(editor.playback.getCurrentTime()).toBe(t(2));
		expect(editor.scenes.getCompoundPath().map((c) => c.name)).toEqual([
			"main",
			"Compound clip 1",
		]);

		expect(editor.scenes.exitCompound()).toBe(true);
		await Promise.resolve();
		expect(editor.scenes.getActiveScene().id).toBe("main");
		expect(editor.playback.getCurrentTime()).toBe(t(3));
		expect(editor.scenes.getCompoundPath().map((c) => c.sceneId)).toEqual(["main"]);
		// Nothing above a user scene.
		expect(editor.scenes.exitCompound()).toBe(false);
	});

	test("breadcrumb at depth 2, and Esc-style exits walk back up one level at a time", async () => {
		const editor = setup();
		const { outer, inner } = await nestedTwoDeep(editor);
		await editor.scenes.enterCompound(outer.compound);
		await editor.scenes.enterCompound(
			refOf(editor.scenes.getActiveScene(), inner.compound.elementId),
		);
		expect(editor.scenes.getCompoundPath().map((c) => c.name)).toEqual([
			"main",
			"Compound clip 1",
			"Compound clip 2",
		]);

		editor.scenes.exitCompound();
		await Promise.resolve();
		expect(editor.scenes.getActiveScene().id).toBe(outer.sceneId);
		editor.scenes.exitCompound();
		await Promise.resolve();
		expect(editor.scenes.getActiveScene().id).toBe("main");
	});

	test("without a hint (e.g. undo switched in) the path is found from the scenes", () => {
		const scenes = [
			scene("main", { overlay: [], main: { id: "m", name: "m", type: "video", muted: false, hidden: false, elements: [] }, audio: [] }),
			scene("other", { overlay: [], main: { id: "o", name: "o", type: "video", muted: false, hidden: false, elements: [{ id: "c", type: "compound", name: "C", sceneId: "nested", startTime: t(0), duration: t(1), trimStart: t(0), trimEnd: t(0), sourceDuration: t(1), params: {} } as CompoundElement] }, audio: [] }, { isMain: false }),
			scene("nested", { overlay: [{ id: "tx", name: "Text", type: "text", hidden: false, elements: [text("x", 0, 1)] }], main: { id: "n", name: "n", type: "video", muted: false, hidden: false, elements: [] }, audio: [] }, { isMain: false, kind: "compound", name: "C" }),
		];
		expect(getCompoundPath({ scenes, sceneId: "nested" }).map((c) => c.sceneId)).toEqual([
			"other",
			"nested",
		]);
		// A stale hint (the parent no longer contains it) is ignored.
		expect(
			getCompoundPath({ scenes, sceneId: "nested", parentHints: new Map([["nested", "main"]]) }).map(
				(c) => c.sceneId,
			),
		).toEqual(["other", "nested"]);
	});

	test("edit inside, go back, Undo switches back into the compound; then break apart", async () => {
		const editor = setup();
		const { compound, sceneId } = editor.timeline.createCompound({ elements: refs });
		await editor.scenes.enterCompound(compound);
		const nested = editor.scenes.getActiveScene();
		editor.timeline.updateElements({
			updates: [{ ...refOf(nested, "box"), patch: { name: "edited box" } }],
		});
		editor.scenes.exitCompound();
		await Promise.resolve();
		expect(editor.scenes.getActiveScene().id).toBe("main");

		editor.command.undo();
		expect(editor.scenes.getActiveScene().id).toBe(sceneId);
		expect(
			allElements(allTracks(editor.scenes.getActiveScene().tracks)).find((e) => e.id === "box")
				?.name,
		).toBe("box");
		expect(editor.scenes.getCompoundPath().map((c) => c.sceneId)).toEqual(["main", sceneId]);

		await editor.scenes.switchToScene({ sceneId: "main" });
		const restored = editor.timeline.ungroupCompound(compound);
		expect(restored.map((r) => r.elementId).sort()).toEqual(["box", "music", "title"]);
		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual(["main"]);
	});
});

describe("compound clip UI: duplicate and paste deep-copy", () => {
	test("duplicate copies nested scenes at depth 2; editing the copy leaves the original", async () => {
		const editor = setup();
		const { outer, inner } = await nestedTwoDeep(editor);
		const originalTree = idTree(editor, outer.sceneId);
		const originalInner = structuredClone(sceneById(editor, inner.sceneId).tracks);

		const [copyRef] = editor.timeline.duplicateElements({ elements: [outer.compound] });
		const host = getHost(editor.scenes.getScenes());
		const copy = compoundsIn(host).find((c) => c.id === copyRef.elementId) as CompoundElement;
		expect(copy.sceneId).not.toBe(outer.sceneId);
		const copiedOuter = sceneById(editor, copy.sceneId);
		expect(copiedOuter.kind).toBe("compound");
		expect(copiedOuter.name).toBe("Compound clip 1 (copy)");
		const [copiedInnerClip] = compoundsIn(copiedOuter);
		expect(copiedInnerClip.sceneId).not.toBe(inner.sceneId);
		// Nothing is shared: no scene, track, or element id of the copy appears in the original.
		const copyTree = idTree(editor, copy.sceneId);
		expect(copyTree.filter((id) => originalTree.includes(id))).toEqual([]);

		// Edit the copy's innermost content.
		await editor.scenes.switchToScene({ sceneId: copiedInnerClip.sceneId });
		const innerCopy = editor.scenes.getActiveScene();
		const [titleCopy] = allElements(allTracks(innerCopy.tracks));
		editor.timeline.updateElements({
			updates: [{ ...refOf(innerCopy, titleCopy.id), patch: { duration: t(9) } }],
		});
		expect(sceneById(editor, inner.sceneId).tracks).toEqual(originalInner);
		expect(idTree(editor, outer.sceneId)).toEqual(originalTree);
	});

	test("undo removes the copied scenes; redo brings back the same ids", async () => {
		const editor = setup();
		const { outer } = await nestedTwoDeep(editor);
		const scenesBefore = editor.scenes.getScenes().map((s) => s.id);
		const [copyRef] = editor.timeline.duplicateElements({ elements: [outer.compound] });
		const copySceneId = (
			compoundsIn(getHost(editor.scenes.getScenes())).find(
				(c) => c.id === copyRef.elementId,
			) as CompoundElement
		).sceneId;
		const tree = idTree(editor, copySceneId);

		editor.command.undo();
		expect(editor.scenes.getScenes().map((s) => s.id)).toEqual(scenesBefore);

		editor.command.redo();
		expect(editor.selection.getSelectedElements()).toEqual([copyRef]);
		expect(idTree(editor, copySceneId)).toEqual(tree);
		expect(editor.scenes.getScenes()).toHaveLength(scenesBefore.length + 2);
	});

	test("paste deep-copies from the copy-time snapshot, even after the original is broken apart", async () => {
		const editor = setup();
		const { outer, inner } = await nestedTwoDeep(editor);
		editor.selection.setSelectedElements({ elements: [outer.compound] });
		expect(editor.clipboard.copy()).toBe(true);

		editor.timeline.ungroupCompound(outer.compound);
		expect(editor.scenes.getScenes().some((s) => s.id === outer.sceneId)).toBe(false);

		expect(editor.clipboard.paste({ time: t(20) })).toBe(true);
		const [pastedRef] = editor.selection.getSelectedElements();
		const pasted = compoundsIn(getHost(editor.scenes.getScenes())).find(
			(c) => c.id === pastedRef.elementId,
		) as CompoundElement;
		expect(pasted.sceneId).not.toBe(outer.sceneId);
		const pastedOuter = sceneById(editor, pasted.sceneId);
		const [pastedInnerClip] = compoundsIn(pastedOuter);
		expect(pastedInnerClip.sceneId).not.toBe(inner.sceneId);

		// Two pastes are independent of each other too.
		expect(editor.clipboard.paste({ time: t(30) })).toBe(true);
		const [secondRef] = editor.selection.getSelectedElements();
		const second = compoundsIn(getHost(editor.scenes.getScenes())).find(
			(c) => c.id === secondRef.elementId,
		) as CompoundElement;
		expect(second.sceneId).not.toBe(pasted.sceneId);

		const tree = idTree(editor, second.sceneId);
		editor.command.undo();
		expect(editor.scenes.getScenes().some((s) => s.id === second.sceneId)).toBe(false);
		editor.command.redo();
		expect(idTree(editor, second.sceneId)).toEqual(tree);
	});

	test("clips copied together that shared a scene (split halves) share one copy", () => {
		const editor = setup();
		const { compound, sceneId } = editor.timeline.createCompound({ elements: refs });
		const right = editor.timeline.splitElements({ elements: [compound], splitTime: t(3) });
		const halves = compoundsIn(getHost(editor.scenes.getScenes()));
		expect(halves.map((c) => c.sceneId)).toEqual([sceneId, sceneId]);

		const { elements, scenes } = deepCopyCompoundElements({
			elements: halves as TimelineElement[],
			sourceScenes: editor.scenes.getScenes(),
		});
		expect(right).toHaveLength(1);
		expect(scenes).toHaveLength(1);
		expect(elements.map((e) => (e as CompoundElement).sceneId)).toEqual([
			scenes[0].id,
			scenes[0].id,
		]);
	});
});

describe("compound clip UI: thumbnail cache", () => {
	test("sample times sit in the middle of equal slots of the visible window", () => {
		expect(getCompoundThumbnailTimes({ element: { trimStart: t(2), duration: t(4) }, count: 4 })).toEqual(
			[t(2.5), t(3.5), t(4.5), t(5.5)],
		);
	});

	test("the key changes when nested content changes at any depth, not for unrelated scenes", async () => {
		const editor = setup();
		const { outer, inner } = await nestedTwoDeep(editor);
		const canvasSize = { width: 1920, height: 1080 };
		const mediaAssets: object[] = [];
		const keyOf = () =>
			getCompoundThumbnailKey({
				scenes: editor.scenes.getScenes(),
				element: findCompound(editor.scenes.getScenes()),
				canvasSize,
				mediaAssets,
			});
		const initial = keyOf();
		expect(keyOf()).toBe(initial);

		// Unrelated edit in main (the clip itself unchanged): same key.
		editor.timeline.updateElements({
			updates: [{ trackId: "t-main", elementId: "bg", patch: { name: "renamed bg" } }],
		});
		expect(keyOf()).toBe(initial);

		// Edit two levels down: new key.
		await editor.scenes.switchToScene({ sceneId: inner.sceneId });
		const innerScene = editor.scenes.getActiveScene();
		editor.timeline.updateElements({
			updates: [{ ...refOf(innerScene, "title"), patch: { params: { content: "changed" } } }],
		});
		const afterEdit = keyOf();
		expect(afterEdit).not.toBe(initial);
		expect(afterEdit.startsWith(outer.sceneId)).toBe(true);

		// Undo brings the old tracks back, so the old strip is reused.
		editor.command.undo();
		expect(keyOf()).toBe(initial);
	});

	test("renders each key once, only when not busy, and drops the least recently used", async () => {
		let busy = true;
		const waits: Array<() => void> = [];
		const cache = new CompoundThumbnailCache({
			isBusy: () => busy,
			wait: () => new Promise<void>((resolve) => waits.push(resolve)),
			limit: 2,
		});
		const renders: string[] = [];
		const render = (key: string) => async () => {
			renders.push(key);
			return [`frame-${key}`];
		};
		const tick = async () => {
			const next = waits.shift();
			next?.();
			await new Promise((resolve) => setTimeout(resolve, 0));
		};

		cache.request("a", render("a"));
		cache.request("a", render("a"));
		await tick(); // busy (playing): nothing renders
		expect(renders).toEqual([]);
		busy = false;
		await tick();
		expect(renders).toEqual(["a"]);
		expect(cache.get("a")).toEqual(["frame-a"]);
		cache.request("a", render("a"));
		expect(waits).toHaveLength(0);

		cache.request("b", render("b"));
		await tick();
		cache.get("a"); // a is now the most recently used
		cache.request("c", render("c"));
		await tick();
		expect(renders).toEqual(["a", "b", "c"]);
		expect(cache.get("b")).toBeUndefined();
		expect(cache.get("a")).toEqual(["frame-a"]);

		// A cancelled request (the clip changed before rendering) never renders.
		cache.request("d", render("d"));
		cache.cancel("d");
		await tick();
		expect(renders).toEqual(["a", "b", "c"]);
	});
});
