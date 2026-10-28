import type { CompoundElement, SceneTracks, TScene, TimelineTrack } from "@/timeline";
import { CompoundCycleError } from "@/timeline/compound";
import { CompoundNode } from "./nodes/compound-node";
import type { MediaAsset } from "@/media/types";
import { RootNode } from "./nodes/root-node";
import { VideoNode } from "./nodes/video-node";
import { Model3dNode } from "./nodes/model3d-node";
import { isModelFile } from "@/media/media-utils";
import { ImageNode } from "./nodes/image-node";
import { TextNode } from "./nodes/text-node";
import { StickerNode } from "./nodes/sticker-node";
import { GraphicNode } from "./nodes/graphic-node";
import { ColorNode } from "./nodes/color-node";
import { BlurBackgroundNode } from "./nodes/blur-background-node";
import { EffectLayerNode } from "./nodes/effect-layer-node";
import type { AnyBaseNode } from "./nodes/base-node";
import type { TBackground, TCanvasSize } from "@/project/types";
import { DEFAULT_BACKGROUND_BLUR_INTENSITY } from "@/background/blur";
import {
	buildTransformFromParams,
	readBlendModeFromParams,
	readOpacityFromParams,
} from "@/rendering";

const PREVIEW_MAX_IMAGE_SIZE = 2048;

function getVisibleSortedElements({ track }: { track: TimelineTrack }) {
	return track.elements
		.filter((element) => !("hidden" in element && element.hidden))
		.slice()
		.sort((a, b) => {
			if (a.startTime !== b.startTime) return a.startTime - b.startTime;
			return a.id.localeCompare(b.id);
		});
}

type BuildContext = {
	mediaMap: Map<string, MediaAsset>;
	canvasSize: TCanvasSize;
	isPreview?: boolean;
	scenes: TScene[];
	/** Compound scenes being built above this level; guards against cycles. */
	sceneStack: string[];
};

function getVisualTracksBottomToTop(tracks: SceneTracks): TimelineTrack[] {
	const visibleTracks = [
		...tracks.overlay.filter((track) => !("hidden" in track && track.hidden)),
		...(!tracks.main.hidden ? [tracks.main] : []),
	];
	return visibleTracks.slice().reverse();
}

function buildCompoundNode({
	element,
	context,
}: {
	element: CompoundElement;
	context: BuildContext;
}): CompoundNode | null {
	const scene = context.scenes.find((s) => s.id === element.sceneId);
	if (!scene) return null;
	if (context.sceneStack.includes(scene.id)) {
		console.warn(new CompoundCycleError(scene.id).message);
		return null;
	}

	const content = new RootNode({ duration: element.sourceDuration ?? element.duration });
	for (const node of buildTrackNodes({
		tracks: getVisualTracksBottomToTop(scene.tracks),
		context: { ...context, sceneStack: [...context.sceneStack, scene.id] },
	})) {
		content.add(node);
	}

	return new CompoundNode({
		content,
		duration: element.duration,
		timeOffset: element.startTime,
		trimStart: element.trimStart,
		trimEnd: element.trimEnd,
		transform: buildTransformFromParams({ params: element.params }),
		animations: element.animations,
		opacity: readOpacityFromParams({ params: element.params }),
		blendMode: readBlendModeFromParams({ params: element.params }),
	});
}

function buildTrackNodes({
	tracks,
	context,
}: {
	tracks: TimelineTrack[];
	context: BuildContext;
}): AnyBaseNode[] {
	const { mediaMap, canvasSize, isPreview } = context;
	const nodes: AnyBaseNode[] = [];

	for (const track of tracks) {
		const elements = getVisibleSortedElements({ track });

		for (const element of elements) {
			if (element.type === "compound") {
				const node = buildCompoundNode({ element, context });
				if (node) nodes.push(node);
				continue;
			}

			if (element.type === "effect") {
				nodes.push(
					new EffectLayerNode({
						effectType: element.effectType,
						effectParams: element.params,
						timeOffset: element.startTime,
						duration: element.duration,
					}),
				);
				continue;
			}

			if (element.type === "video" || element.type === "image") {
				const mediaAsset = mediaMap.get(element.mediaId);
				if (!mediaAsset?.file || !mediaAsset?.url) {
					continue;
				}

				if (element.type === "video" && mediaAsset.type === "video") {
					nodes.push(
						new VideoNode({
							mediaId: mediaAsset.id,
							url: mediaAsset.url,
							file: mediaAsset.file,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							retime: element.retime,
							transform: buildTransformFromParams({ params: element.params }),
							animations: element.animations,
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							effects: element.effects ?? [],
							masks: element.masks ?? [],
						}),
					);
				}
				if (element.type === "image" && mediaAsset.type === "image" && isModelFile(mediaAsset.file)) {
					nodes.push(new Model3dNode({
						mediaId: mediaAsset.id, file: mediaAsset.file, params: element.params,
						duration: element.duration, timeOffset: element.startTime,
						trimStart: element.trimStart, trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations, opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [], masks: element.masks ?? [],
					}));
				} else if (element.type === "image" && mediaAsset.type === "image") {
					nodes.push(
						new ImageNode({
							url: mediaAsset.url,
							duration: element.duration,
							timeOffset: element.startTime,
							trimStart: element.trimStart,
							trimEnd: element.trimEnd,
							transform: buildTransformFromParams({ params: element.params }),
							animations: element.animations,
							opacity: readOpacityFromParams({ params: element.params }),
							blendMode: readBlendModeFromParams({ params: element.params }),
							effects: element.effects ?? [],
							masks: element.masks ?? [],
							...(isPreview && {
								maxSourceSize: PREVIEW_MAX_IMAGE_SIZE,
							}),
						}),
					);
				}
			}

			if (element.type === "text") {
				nodes.push(
					new TextNode({
						...element,
						transform: buildTransformFromParams({ params: element.params }),
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						canvasCenter: { x: canvasSize.width / 2, y: canvasSize.height / 2 },
						canvasHeight: canvasSize.height,
						textBaseline: "middle",
						effects: element.effects ?? [],
					}),
				);
			}

			if (element.type === "sticker") {
				nodes.push(
					new StickerNode({
						stickerId: element.stickerId,
						intrinsicWidth: element.intrinsicWidth,
						intrinsicHeight: element.intrinsicHeight,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations,
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
					}),
				);
			}

			if (element.type === "graphic") {
				nodes.push(
					new GraphicNode({
						definitionId: element.definitionId,
						params: element.params,
						duration: element.duration,
						timeOffset: element.startTime,
						trimStart: element.trimStart,
						trimEnd: element.trimEnd,
						transform: buildTransformFromParams({ params: element.params }),
						animations: element.animations,
						opacity: readOpacityFromParams({ params: element.params }),
						blendMode: readBlendModeFromParams({ params: element.params }),
						effects: element.effects ?? [],
						masks: element.masks ?? [],
					}),
				);
			}
		}
	}

	return nodes;
}

function buildBlurBackgroundNodes({
	track,
	mediaMap,
	blurIntensity,
}: {
	track: TimelineTrack | undefined;
	mediaMap: Map<string, MediaAsset>;
	blurIntensity: number;
}): AnyBaseNode[] {
	if (!track) {
		return [];
	}

	const nodes: AnyBaseNode[] = [];
	const elements = getVisibleSortedElements({ track });

	for (const element of elements) {
		if (element.type !== "video" && element.type !== "image") {
			continue;
		}

		const mediaAsset = mediaMap.get(element.mediaId);
		if (
			!mediaAsset?.file ||
			!mediaAsset?.url ||
			(mediaAsset.type !== "video" && mediaAsset.type !== "image")
		) {
			continue;
		}

		nodes.push(
			new BlurBackgroundNode({
				mediaId: mediaAsset.id,
				url: mediaAsset.url,
				file: mediaAsset.file,
				mediaType: mediaAsset.type,
				duration: element.duration,
				timeOffset: element.startTime,
				trimStart: element.trimStart,
				trimEnd: element.trimEnd,
				retime: element.type === "video" ? element.retime : undefined,
				blurIntensity,
			}),
		);
	}

	return nodes;
}

export type BuildSceneParams = {
	canvasSize: TCanvasSize;
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	background: TBackground;
	isPreview?: boolean;
	/** All project scenes, so compound clips can find their nested scene. */
	scenes?: TScene[];
};

export function buildScene({
	canvasSize,
	tracks,
	mediaAssets,
	duration,
	background,
	isPreview,
	scenes = [],
}: BuildSceneParams) {
	const rootNode = new RootNode({ duration });
	const mediaMap = new Map(mediaAssets.map((m) => [m.id, m]));
	const mainTrack = tracks.main.hidden ? undefined : tracks.main;

	const allNodes = buildTrackNodes({
		tracks: getVisualTracksBottomToTop(tracks),
		context: { mediaMap, canvasSize, isPreview, scenes, sceneStack: [] },
	});

	if (background.type === "blur") {
		const blurNodes = buildBlurBackgroundNodes({
			track: mainTrack,
			mediaMap,
			blurIntensity:
				background.blurIntensity ?? DEFAULT_BACKGROUND_BLUR_INTENSITY,
		});
		for (const node of blurNodes) {
			rootNode.add(node);
		}
	} else if (
		background.type === "color" &&
		background.color !== "transparent"
	) {
		rootNode.add(new ColorNode({ color: background.color }));
	}

	for (const node of allNodes) {
		rootNode.add(node);
	}

	return rootNode;
}
