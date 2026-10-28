export type PreviewQuality = "full" | "half" | "quarter";

export function previewQualityScale(quality: PreviewQuality): number {
	switch (quality) {
		case "full":
			return 1;
		case "half":
			return 0.5;
		case "quarter":
			return 0.25;
	}
}

export function isPreviewQuality(value: unknown): value is PreviewQuality {
	return value === "full" || value === "half" || value === "quarter";
}
