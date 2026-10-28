import { toast } from "sonner";
import type { SerializedProject, MediaAssetData } from "./types";

const base = "/api/storage/projects";
const projectUrl = (id: string) => `${base}/${encodeURIComponent(id)}`;
async function checked(response: Response): Promise<Response> {
	if (!response.ok)
		throw new Error(
			`Penyimpanan gagal (${response.status}): ${await response.text()}`,
		);
	return response;
}

export class DiskAdapter {
	private revisions = new Map<string, string>();
	private writes = new Map<string, Promise<void>>();
	async get(id: string): Promise<SerializedProject | null> {
		const response = await fetch(projectUrl(id), { cache: "no-store" });
		if (response.status === 404) {
			this.revisions.delete(id);
			return null;
		}
		await checked(response);
		this.revisions.set(id, response.headers.get("etag") ?? "new");
		return response.json();
	}
	async getAll(): Promise<SerializedProject[]> {
		return (await checked(await fetch(base, { cache: "no-store" }))).json();
	}
	async list(): Promise<string[]> {
		return (await this.getAll()).map((project) => project.metadata.id);
	}
	async set({
		key,
		value,
	}: {
		key: string;
		value: SerializedProject;
	}): Promise<void> {
		const previous = this.writes.get(key) ?? Promise.resolve();
		const current = previous
			.catch(() => undefined)
			.then(() => this.writeProject(key, value));
		this.writes.set(key, current);
		try {
			await current;
		} finally {
			if (this.writes.get(key) === current) this.writes.delete(key);
		}
	}
	private async writeProject(
		key: string,
		value: SerializedProject,
	): Promise<void> {
		let expected = this.revisions.get(key);
		if (!expected) {
			await this.get(key);
			expected = this.revisions.get(key) ?? "new";
		}
		const write = (version: string) =>
			fetch(projectUrl(key), {
				method: "PUT",
				headers: { "Content-Type": "application/json", "If-Match": version },
				body: JSON.stringify(value),
			});
		let response = await write(expected);
		if (response.status === 409) {
			toast.warning(
				"Proyek juga diubah di browser lain; penyimpanan terbaru akan menimpa perubahan tersebut.",
			);
			for (let attempt = 0; attempt < 3 && response.status === 409; attempt++) {
				await this.get(key);
				response = await write(this.revisions.get(key) ?? "new");
			}
		}
		await checked(response);
		this.revisions.set(key, response.headers.get("etag") ?? "new");
	}
	async migrate(value: SerializedProject): Promise<boolean> {
		const response = await checked(
			await fetch(projectUrl(value.metadata.id), {
				method: "PUT",
				headers: { "Content-Type": "application/json", "X-Migration": "1" },
				body: JSON.stringify(value),
			}),
		);
		return !(await response.json()).skipped;
	}
	async migrationExists(id: string): Promise<boolean> {
		return (
			await (
				await checked(
					await fetch(`${projectUrl(id)}/migration`, { cache: "no-store" }),
				)
			).json()
		).exists;
	}
	async remove(id: string): Promise<void> {
		await checked(await fetch(projectUrl(id), { method: "DELETE" }));
		this.revisions.delete(id);
	}
	async clear(): Promise<void> {
		for (const id of await this.list()) await this.remove(id);
	}
	async mediaList(id: string): Promise<MediaAssetData[]> {
		return (
			await checked(
				await fetch(`${projectUrl(id)}/media`, { cache: "no-store" }),
			)
		).json();
	}
	mediaUrl(id: string, mediaId: string): string {
		return `${projectUrl(id)}/media/${encodeURIComponent(mediaId)}`;
	}
	async saveMedia(
		id: string,
		metadata: MediaAssetData,
		file: File,
	): Promise<void> {
		const url = this.mediaUrl(id, metadata.id);
		const minimal = {
			id: metadata.id,
			fileName: metadata.fileName,
			fileType: metadata.fileType,
		};
		await checked(
			await fetch(url, {
				method: "PUT",
				headers: {
					"X-Media-Metadata": encodeURIComponent(JSON.stringify(minimal)),
				},
				body: file,
			}),
		);
		await checked(
			await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(metadata),
			}),
		);
	}
	async removeMedia(id: string, mediaId: string): Promise<void> {
		await checked(
			await fetch(this.mediaUrl(id, mediaId), { method: "DELETE" }),
		);
	}
	async removeProjectMedia(id: string): Promise<void> {
		await checked(await fetch(`${projectUrl(id)}/media`, { method: "DELETE" }));
	}
}

export class DiskSoundsAdapter<T> {
	async get(_key: string): Promise<T | null> {
		return (
			await checked(await fetch("/api/storage/sounds", { cache: "no-store" }))
		).json();
	}
	async set({ value }: { key: string; value: T }): Promise<void> {
		await checked(
			await fetch("/api/storage/sounds", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(value),
			}),
		);
	}
	async migrate(value: T): Promise<void> {
		await checked(
			await fetch("/api/storage/sounds", {
				method: "PUT",
				headers: { "Content-Type": "application/json", "If-None-Match": "*" },
				body: JSON.stringify(value),
			}),
		);
	}
	async remove(_key: string): Promise<void> {
		await checked(await fetch("/api/storage/sounds", { method: "DELETE" }));
	}
}
