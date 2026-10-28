import { mock } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageUrl = import.meta.resolve("opencut-wasm");
const backgroundUrl = new URL("./opencut_wasm_bg.js", packageUrl);
const wasmUrl = new URL("./opencut_wasm_bg.wasm", packageUrl);
const background = await import(backgroundUrl.href);
const module = new WebAssembly.Module(readFileSync(fileURLToPath(wasmUrl)));
const instance = new WebAssembly.Instance(module, {
	"./opencut_wasm_bg.js": background,
});
background.__wbg_set_wasm(instance.exports);
instance.exports.__wbindgen_start();
mock.module("opencut-wasm", () => background);
