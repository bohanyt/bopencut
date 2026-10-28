// Measures loading every media asset of a synthetic project through the real storage route.
//   bun scripts/bench-media-load.ts [count=600] [metadataKB=42]
// Creates a temporary data folder with `count` small media files whose metadata carry
// `metadataKB` of thumbnail data each (a 593-asset project measured 25 MB of metadata), routes
// fetch to the storage route handler in-process, and reports time, requests, and bytes read.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// The wasm package needs manual instantiation outside Next (same as test-wasm-setup.js).
const packageUrl = import.meta.resolve("opencut-wasm");
const background = await import(new URL("./opencut_wasm_bg.js", packageUrl).href);
const instance = new WebAssembly.Instance(new WebAssembly.Module(await fs.readFile(new URL("./opencut_wasm_bg.wasm", packageUrl))), { "./opencut_wasm_bg.js": background });
background.__wbg_set_wasm(instance.exports);
(instance.exports.__wbindgen_start as () => void)();
Bun.plugin({ name: "opencut-wasm", setup: (build) => { build.module("opencut-wasm", () => ({ exports: background, loader: "object" })); } });

const count = Number(process.argv[2] ?? 600);
const metadataKB = Number(process.argv[3] ?? 42);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "bopencut-bench-"));
process.env.BOPENCUT_DATA = root;

const { GET } = await import("../src/app/api/storage/[...slug]/route");
const { StorageService } = await import("../src/services/storage/service");

const projectId = "bench";
const dir = path.join(root, "projects", projectId, "media");
await fs.mkdir(path.join(dir, "_metadata"), { recursive: true });
const thumbnail = `data:image/jpeg;base64,${"A".repeat(metadataKB * 1024)}`;
for (let n = 0; n < count; n++) {
	const id = `media-${n}`;
	await fs.writeFile(path.join(dir, `${id}.png`), Buffer.alloc(2048, n % 256));
	await fs.writeFile(path.join(dir, "_metadata", `${id}.json`), JSON.stringify({ id, name: id, type: "image", fileName: `${id}.png`, fileType: "image/png", size: 2048, lastModified: 0, width: 64, height: 64, thumbnailUrl: thumbnail, diskFile: `${id}.png` }));
}

const stats = { lists: 0, files: 0, bytes: 0 };
globalThis.fetch = (async (input: string, init?: RequestInit) => {
	const url = new URL(String(input), "http://127.0.0.1:3000");
	const slug = url.pathname.replace(/^\/api\/storage\//, "").split("/").map(decodeURIComponent);
	const response = await GET(new Request(url, init), { params: Promise.resolve({ slug }) });
	const body = await response.arrayBuffer();
	if (slug.length === 3 && slug[2] === "media") stats.lists++;
	else stats.files++;
	stats.bytes += body.byteLength;
	return new Response(body, { status: response.status, headers: response.headers });
}) as typeof fetch;

const started = performance.now();
const assets = await new StorageService().loadAllMediaAssets({ projectId });
const ms = performance.now() - started;
console.log(JSON.stringify({ count, metadataKB, loaded: assets.length, ms: Math.round(ms), listRequests: stats.lists, fileRequests: stats.files, mbRead: Math.round(stats.bytes / 1e5) / 10 }));
await fs.rm(root, { recursive: true, force: true });
