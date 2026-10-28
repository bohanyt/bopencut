import type { MediaAsset, MediaType } from "@/media/types";

export const SUPPORTS_AUDIO: readonly MediaType[] = ["audio", "video"];

export function mediaSupportsAudio({
	media,
}: {
	media: MediaAsset | null | undefined;
}): boolean {
	if (!media) return false;
	return SUPPORTS_AUDIO.includes(media.type);
}

export const isModelFile = (file: File): boolean => /\.(glb|gltf)$/i.test(file.name);

export const getMediaTypeFromFile = ({
	file,
}: {
	file: File;
}): MediaType | null => {
	const { type } = file;

	if (isModelFile(file)) return "image";

	if (type.startsWith("image/")) {
		return "image";
	}
	if (type.startsWith("video/")) {
		return "video";
	}
	if (type.startsWith("audio/")) {
		return "audio";
	}

	return null;
};
