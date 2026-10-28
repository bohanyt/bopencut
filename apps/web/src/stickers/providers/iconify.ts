import { buildStickerId, parseStickerId } from "../sticker-id";
import type { StickerItem, StickerProvider, StickerSearchResult } from "../types";

const API = "https://api.iconify.design";
export function iconUrl(name: string): string {
	if (!/^[a-z0-9-]+:[a-z0-9-]+$/.test(name)) throw new Error("Invalid icon name");
	return `${API}/${name.replace(":", "/")}.svg`;
}
export async function loadIcon(name: string): Promise<string> {
	const response = await fetch(iconUrl(name));
	if (!response.ok) throw new Error(`Icon not available: ${name}`);
	return response.text();
}
function item(name: string): StickerItem {
	return { id: buildStickerId({ providerId: "icons", providerValue: name }), provider: "icons", name, previewUrl: iconUrl(name), metadata: {} };
}
export const iconifyProvider: StickerProvider = {
	id: "icons",
	async search({ query, options }): Promise<StickerSearchResult> {
		const response = await fetch(`${API}/search?query=${encodeURIComponent(query)}&prefixes=lucide&limit=${options?.limit ?? 100}`);
		if (!response.ok) throw new Error("Icon search failed");
		const data = await response.json() as { icons: string[]; total: number };
		const icons = data.icons.filter((name) => /^lucide:[a-z0-9-]+$/.test(name));
		return { items: icons.map(item), total: data.total, hasMore: data.total > icons.length };
	},
	async browse({ options }) {
		const result = await this.search({ query: "popular", options });
		return { sections: [{ id: "all", items: result.items, hasMore: result.hasMore, layout: "grid" }] };
	},
	resolveUrl({ stickerId }) { return iconUrl(parseStickerId({ stickerId }).providerValue); },
};
