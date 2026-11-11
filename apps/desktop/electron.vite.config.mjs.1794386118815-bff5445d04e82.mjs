import { createRequire } from "node:module";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve as resolve$1, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// ../../packages/mica-web-shared/runtime-port.js
/** 默认端口：没有任何配置时运行时监听它，也是「本机」这个地址的端口。 */
const DEFAULT_RUNTIME_PORT = 8787;
/** 覆盖默认端口的变量：运行时、Electron 外壳、Vite dev server 的代理都读同一个。 */
const RUNTIME_PORT_ENV = "MICA_DESKTOP_PORT";
/** 回环地址：外壳、页面和 agent 都从这台机器上的这个地址进运行时。 */
const RUNTIME_LOOPBACK_HOST = "127.0.0.1";
/**
* 把端口值（env 字符串、命令行参数、数字）解析成端口号。
*
* 非法值（空、不是整数、超出 1-65535）一律落回 `fallback`，调用方不用各自写一遍
* 「`parseInt` 之后判 `NaN`」——以前这几处就是这么分叉的。
*
* @param {unknown} value
* @param {number} [fallback]
* @returns {number}
*/
function parseRuntimePort(value, fallback = DEFAULT_RUNTIME_PORT) {
	const text = typeof value === "number" ? null : String(value ?? "").trim();
	const parsed = text === null ? value : /^\d+$/.test(text) ? Number(text) : NaN;
	if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return fallback;
	return parsed;
}
/**
* 某个端口上的回环地址：这台机器上的那台运行时，也就是界面里的「本机」。
*
* @param {number | string} [port]
* @returns {string}
*/
function loopbackRuntimeUrl(port = DEFAULT_RUNTIME_PORT) {
	return `http://${RUNTIME_LOOPBACK_HOST}:${parseRuntimePort(port)}`;
}
loopbackRuntimeUrl();
// scripts/file-icon-assets.mjs
const __electron_vite_injected_import_meta_url$2 = "file:///Users/qironglin/Desktop/VsGo-Projects/mica-code/apps/desktop/scripts/file-icon-assets.mjs";
const manifestPath = fileURLToPath(new URL("../src/renderer/src/vscode-icons-manifest.json", __electron_vite_injected_import_meta_url$2));
const iconDir = fileURLToPath(new URL("../src/renderer/assets/file-icons", __electron_vite_injected_import_meta_url$2));
const virtualId = "virtual:file-icon-assets";
const resolvedVirtualId = `\0${virtualId}`;
function reachableIconNames(manifest) {
	const names = /* @__PURE__ */ new Set([
		`default_${manifest.defaults.file}`,
		`default_${manifest.defaults.folder}`,
		`default_${manifest.defaults.folder}_opened`
	]);
	for (const name of [
		...Object.values(manifest.files),
		...Object.values(manifest.extensions),
		manifest.defaults.file
	]) names.add(`file_type_${name}`);
	for (const name of [...Object.values(manifest.folders), manifest.defaults.folder]) {
		names.add(`folder_type_${name}`);
		names.add(`folder_type_${name}_opened`);
	}
	return names;
}
function urlPath(path) {
	return path.split(sep).filter(Boolean).map((part) => /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join("/");
}
function fileIconAssets() {
	let config;
	return {
		name: "mica:file-icon-assets",
		configResolved(resolved) {
			config = resolved;
		},
		resolveId(id) {
			return id === virtualId ? resolvedVirtualId : null;
		},
		async load(id) {
			if (id !== resolvedVirtualId) return null;
			this.addWatchFile(manifestPath);
			const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
			const available = new Set(await readdir(iconDir));
			const names = [...reachableIconNames(manifest)].filter((name) => available.has(`${name}.svg`)).sort();
			if (config.command === "serve") {
				const dirFromRoot = relative(config.root, iconDir);
				const urlDir = dirFromRoot !== ".." && !dirFromRoot.startsWith(`..${sep}`) && !isAbsolute(dirFromRoot) ? urlPath(dirFromRoot) : `@fs/${urlPath(iconDir)}`;
				const base = `${(config.server.origin || "").replace(/\/$/, "")}${config.base}`;
				const entries = names.map((name) => [name, `${base}${urlDir}/${encodeURIComponent(name)}.svg`]);
				return `export default ${JSON.stringify(Object.fromEntries(entries))}`;
			}
			const sources = [];
			for (let index = 0; index < names.length; index += 64) {
				const batch = names.slice(index, index + 64);
				const batchSources = await Promise.all(batch.map(async (name) => {
					const path = join(iconDir, `${name}.svg`);
					this.addWatchFile(path);
					return readFile(path);
				}));
				sources.push(...batchSources);
			}
			if (config.build.watch) this.addWatchFile(iconDir);
			return `export default {${names.map((name, index) => {
				const ref = this.emitFile({
					type: "asset",
					name: `${name}.svg`,
					source: sources[index]
				});
				return `${JSON.stringify(name)}: import.meta.ROLLDOWN_FILE_URL_${ref}`;
			}).join(",")}}`;
		},
		configureServer(server) {
			server.watcher.add(iconDir);
			server.watcher.on("all", (event, file) => {
				if (![
					"add",
					"change",
					"unlink"
				].includes(event) || dirname(file).replaceAll("\\", "/") !== iconDir.replaceAll("\\", "/") || !file.endsWith(".svg")) return;
				const module = server.moduleGraph.getModuleById(resolvedVirtualId);
				if (!module) return;
				server.moduleGraph.invalidateModule(module);
				server.ws.send({ type: "full-reload" });
			});
		}
	};
}
// scripts/plugin-web-assets.mjs
const __electron_vite_injected_import_meta_url$1 = "file:///Users/qironglin/Desktop/VsGo-Projects/mica-code/apps/desktop/scripts/plugin-web-assets.mjs";
const pluginsRoot = fileURLToPath(new URL("../../../plugins/", __electron_vite_injected_import_meta_url$1));
const prefix$1 = "/plugin-web/";
/**
* 隔离 Web 运行时的通用构建入口。插件只须提供 web-build.mjs，不在宿主登记业务名词。
* 产物仍属于 renderer 静态资源，由既有 HTTP 服务托管；第三方依赖策略由插件自行决定。
*/
function pluginWebAssets() {
	let config;
	const builds = /* @__PURE__ */ new Map();
	let devRoot;
	async function builders() {
		return (await readdir(pluginsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).filter((name) => /^[a-z0-9][a-z0-9._-]*$/.test(name));
	}
	async function buildOne(id, root) {
		const script = join(pluginsRoot, id, "web-build.mjs");
		try {
			await readFile(script);
		} catch (error) {
			if (error.code === "ENOENT") return false;
			throw error;
		}
		const module = await import(pathToFileURL(script).href);
		const outDir = join(root, id);
		await mkdir(dirname(outDir), { recursive: true });
		await module.default({ outDir });
		return true;
	}
	return {
		name: "mica:plugin-web-assets",
		configResolved(value) {
			config = value;
		},
		async closeBundle() {
			if (config.command !== "build") return;
			const root = resolve$1(config.root, config.build.outDir, "plugin-web");
			for (const id of await builders()) await buildOne(id, root);
		},
		configureServer(server) {
			devRoot = fileURLToPath(new URL("../../../temp/plugin-web-dev/", __electron_vite_injected_import_meta_url$1));
			server.middlewares.use(async (req, res, next) => {
				const path = new URL(req.url, "http://localhost").pathname;
				if (!path.startsWith(prefix$1)) return next();
				const [, id, ...encodedParts] = path.slice(11).split("/");
				let parts;
				try {
					parts = encodedParts.map(decodeURIComponent);
				} catch {
					return next();
				}
				if (!/^[a-z0-9][a-z0-9._-]*$/.test(id || "") || parts.some((part) => part === ".." || part.includes("/") || part.includes("\\"))) return next();
				try {
					if (!builds.has(id)) builds.set(id, buildOne(id, devRoot));
					if (!await builds.get(id)) return next();
					const asset = resolve$1(devRoot, id, parts.join("/") || "index.html");
					if (!asset.startsWith(resolve$1(devRoot, id) + "/")) return next();
					const bytes = await readFile(asset);
					res.setHeader("Content-Type", {
						html: "text/html",
						js: "text/javascript",
						css: "text/css",
						svg: "image/svg+xml",
						woff2: "font/woff2"
					}[asset.split(".").pop()] || "application/octet-stream");
					res.setHeader("Access-Control-Allow-Origin", "*");
					res.setHeader("Cache-Control", "no-store");
					res.end(bytes);
				} catch (error) {
					builds.delete(id);
					if (error.code === "ENOENT") return next();
					server.config.logger.error(String(error.stack || error));
					res.statusCode = 500;
					res.end("插件页面构建失败，请检查开发服务日志");
				}
			});
			server.watcher.on("change", (file) => {
				if (!file.startsWith(pluginsRoot)) return;
				const id = file.slice(pluginsRoot.length).split("/")[0];
				if (file.includes("/editor/")) builds.delete(id);
			});
		}
	};
}
// ../../packages/mica-editor/build.mjs
const __electron_vite_injected_import_meta_url = "file:///Users/qironglin/Desktop/VsGo-Projects/mica-code/packages/mica-editor/build.mjs";
const runtimeRoot = fileURLToPath(new URL("./runtime/", __electron_vite_injected_import_meta_url));
const themeFile = fileURLToPath(new URL("../mica-config-ui/web/arco-settings.css", __electron_vite_injected_import_meta_url));
const devRoot = fileURLToPath(new URL("../../temp/editor-web-dev/", __electron_vite_injected_import_meta_url));
const runtimeRequire = createRequire(new URL("./runtime/package.json", __electron_vite_injected_import_meta_url));
const prefix = "/editor/";
const contentTypes = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".txt": "text/plain; charset=utf-8"
};
/** Build the one isolated runtime with its own pinned development toolchain. */
async function buildEditorAssets({ outDir }) {
	const { build } = await import(pathToFileURL(runtimeRequire.resolve("vite")).href);
	await build({
		configFile: resolve$1(runtimeRoot, "vite.config.mjs"),
		build: {
			outDir: resolve$1(outDir),
			emptyOutDir: true
		}
	});
}
/** Both browser hosts serve the same /editor/ assets; no plugin owns this build. */
function editorWebAssets() {
	let config;
	let pendingBuild;
	let revision = 0;
	let builtRevision = -1;
	let stopWatching;
	async function ensureDevBuild() {
		while (builtRevision !== revision) {
			if (!pendingBuild) {
				const buildingRevision = revision;
				pendingBuild = buildEditorAssets({ outDir: devRoot }).then(() => {
					builtRevision = buildingRevision;
				}).finally(() => {
					pendingBuild = void 0;
				});
			}
			await pendingBuild;
		}
	}
	return {
		name: "mica:editor-web-assets",
		configResolved(value) {
			config = value;
		},
		async closeBundle() {
			stopWatching?.();
			if (config.command !== "build") return;
			await buildEditorAssets({ outDir: resolve$1(config.root, config.build.outDir, "editor") });
		},
		configureServer(server) {
			const invalidate = (_event, file) => {
				const path = resolve$1(file);
				const parts = relative(runtimeRoot, path).split(sep);
				if (path !== themeFile && (!path.startsWith(runtimeRoot) || parts.some((part) => [
					"node_modules",
					"dist",
					"coverage",
					".vite"
				].includes(part)))) return;
				revision += 1;
			};
			server.watcher.add([runtimeRoot, themeFile]);
			server.watcher.on("all", invalidate);
			stopWatching = () => server.watcher.off("all", invalidate);
			server.middlewares.use(async (req, res, next) => {
				const pathname = (req.url || "").split(/[?#]/, 1)[0];
				if (pathname !== "/editor" && !pathname.startsWith(prefix)) return next();
				res.setHeader("Access-Control-Allow-Origin", "*");
				res.setHeader("Cache-Control", "no-store");
				res.setHeader("X-Content-Type-Options", "nosniff");
				const fail = (status, message) => {
					res.statusCode = status;
					res.setHeader("Content-Type", "text/plain; charset=utf-8");
					res.end(req.method === "HEAD" ? void 0 : message);
				};
				if (req.method !== "GET" && req.method !== "HEAD") {
					res.setHeader("Allow", "GET, HEAD");
					return fail(405, "Method not allowed");
				}
				let parts;
				try {
					parts = pathname.slice(8).split("/").map(decodeURIComponent);
				} catch {
					return fail(404, "Not found");
				}
				if (parts.some((part) => part === ".." || part === "." || /[/\\\x00-\x1f\x7f]/.test(part))) return fail(404, "Not found");
				try {
					await ensureDevBuild();
				} catch (error) {
					server.config.logger.error(String(error.stack || error));
					return fail(500, "编辑器页面构建失败，请检查开发服务日志");
				}
				try {
					const root = await realpath(devRoot);
					const asset = await realpath(resolve$1(root, parts.join("/") || "index.html"));
					if (!asset.startsWith(root + sep)) return fail(404, "Not found");
					const bytes = await readFile(asset);
					res.setHeader("Content-Type", contentTypes[extname(asset).toLowerCase()] || "application/octet-stream");
					res.setHeader("Content-Length", bytes.byteLength);
					res.end(req.method === "HEAD" ? void 0 : bytes);
				} catch (error) {
					if ([
						"ENOENT",
						"ENOTDIR",
						"EISDIR"
					].includes(error.code)) return fail(404, "Not found");
					server.config.logger.error(String(error.stack || error));
					fail(500, "编辑器资源读取失败，请检查开发服务日志");
				}
			});
		}
	};
}
// electron.vite.config.mjs
/**
* 应用的运行时是 Web 页面（由 vite.server.config.mjs 构建的 out/server 托管），
* 这里只构建 Electron 外壳 main 和 renderer 页面本身。
*
* dev 下页面走 Vite dev server（HMR），运行时另行启动，因此把 /api 代理到它，
* 让页面在两种模式下都保持同源调用。端口与外壳一致（MICA_DESKTOP_PORT 可覆盖）。
*
* preload 只提供客户端专属能力（本机插件数据、探活和窗口切换）；运行时业务仍走 HTTP + SSE。
*/
const runtimePort = parseRuntimePort(process.env[RUNTIME_PORT_ENV]);
/**
* 把 `import { IconX, IconY } from '@tabler/icons-react'` 改写成逐个深路径导入。
*
* 上游包的 barrel（dist/esm/tabler-icons-react.mjs）除了 re-export 全部 6197 个图标模块，
* 还会 `import * as index from './icons/index.mjs'`。tree-shaking 后产物里只剩实际用到的
* 几十个图标，体积没差别，但构建期仍要解析这 6000 多个模块：实测 renderer 段 10870 →
* 4749 个模块、快 1.5~2s。用 transform 改写而不是维护一份图标清单，源码写法保持不变，
* 新增图标时也不需要同步任何东西。
*
* 只对 build 生效：dev 下改写会让每个图标各成一个 optimizeDeps 预构建产物（实测 100 个
* deps 文件），冷启动反而更慢；dev 交给 Vite 把整个 barrel 预构建成一份即可。
*/
function tablerIconDeepImports() {
	const specifier = "@tabler/icons-react";
	const deep = `${specifier}/dist/esm/icons`;
	return {
		name: "mica:tabler-icon-deep-imports",
		apply: "build",
		enforce: "pre",
		transform(code, id) {
			if (id.includes("/node_modules/") || !code.includes(specifier)) return null;
			const namedImport = /import\s*\{([^}]*)\}\s*from\s*(['"])@tabler\/icons-react\2\s*;?/g;
			if (!namedImport.test(code)) return null;
			return code.replace(namedImport, (_match, names) => {
				return `${names.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
					const [exported, local] = entry.split(/\s+as\s+/).map((value) => value.trim());
					return `import ${local || exported} from '${deep}/${exported}.mjs'`;
				}).join("\n")}\n`;
			});
		}
	};
}
var electron_vite_config_default = defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		resolve: { alias: {
			"@packages": resolve("../../packages"),
			"@mica-app-paths": resolve("../../packages/mica-web-shared/app-paths.ts")
		} }
	},
	preload: { build: { rolldownOptions: {
		input: resolve("src/preload/index.js"),
		output: {
			format: "cjs",
			entryFileNames: "index.js"
		}
	} } },
	renderer: {
		plugins: [
			tablerIconDeepImports(),
			fileIconAssets(),
			pluginWebAssets(),
			editorWebAssets(),
			react(),
			tailwindcss()
		],
		resolve: {
			dedupe: ["react", "react-dom"],
			alias: {
				"@renderer": resolve("src/renderer/src"),
				"@packages": resolve("../../packages"),
				"@plugins": resolve("../../plugins"),
				"@mica-config-ui/web": resolve("../../packages/mica-config-ui/web/index.tsx"),
				"@mica-config-ui/plugin-icons": resolve("../../packages/mica-config-ui/web/pluginIcons.tsx")
			}
		},
		server: { proxy: {
			"/api": {
				target: `http://127.0.0.1:${runtimePort}`,
				changeOrigin: false
			},
			"/remote": {
				target: `http://127.0.0.1:${runtimePort}`,
				changeOrigin: false
			}
		} },
		build: {
			rollupOptions: { input: {
				index: resolve("src/renderer/index.html"),
				terminal: resolve("src/renderer/terminal.html")
			} },
			minify: true,
			reportCompressedSize: false,
			chunkSizeWarningLimit: 2048
		}
	}
});
export { electron_vite_config_default as default };

//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZWxlY3Ryb24udml0ZS5jb25maWcuanMiLCJuYW1lcyI6WyJfX2VsZWN0cm9uX3ZpdGVfaW5qZWN0ZWRfaW1wb3J0X21ldGFfdXJsIiwiX19lbGVjdHJvbl92aXRlX2luamVjdGVkX2ltcG9ydF9tZXRhX3VybCIsInByZWZpeCIsInJlc29sdmUiLCJyZXNvbHZlIl0sInNvdXJjZXMiOlsiL1VzZXJzL3Fpcm9uZ2xpbi9EZXNrdG9wL1ZzR28tUHJvamVjdHMvbWljYS1jb2RlL3BhY2thZ2VzL21pY2Etd2ViLXNoYXJlZC9ydW50aW1lLXBvcnQuanMiLCIvVXNlcnMvcWlyb25nbGluL0Rlc2t0b3AvVnNHby1Qcm9qZWN0cy9taWNhLWNvZGUvYXBwcy9kZXNrdG9wL3NjcmlwdHMvZmlsZS1pY29uLWFzc2V0cy5tanMiLCIvVXNlcnMvcWlyb25nbGluL0Rlc2t0b3AvVnNHby1Qcm9qZWN0cy9taWNhLWNvZGUvYXBwcy9kZXNrdG9wL3NjcmlwdHMvcGx1Z2luLXdlYi1hc3NldHMubWpzIiwiL1VzZXJzL3Fpcm9uZ2xpbi9EZXNrdG9wL1ZzR28tUHJvamVjdHMvbWljYS1jb2RlL3BhY2thZ2VzL21pY2EtZWRpdG9yL2J1aWxkLm1qcyIsIi9Vc2Vycy9xaXJvbmdsaW4vRGVza3RvcC9Wc0dvLVByb2plY3RzL21pY2EtY29kZS9hcHBzL2Rlc2t0b3AvZWxlY3Ryb24udml0ZS5jb25maWcubWpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICog6L+Q6KGM5pe256uv5Y+j77ya5pW05Liq5bqU55So5Y+q5pyJ6L+Z5LiA5LiqIFRDUCDnq6/lj6PvvIzpu5jorqQgYDg3ODdg44CCXG4gKlxuICog5qGM6Z2i6L+Q6KGM5pe277yIYG91dC9zZXJ2ZXIvaW5kZXgubWpzYO+8ieebkeWQrOWug++8jOmhtemdouOAgeWIhuS6q+inhuWbvuOAgee7iOerr+aOp+WItueql+WPo+OAgeWPl+aOp+a1j+iniOWZqOS4jlxuICog57uI56uv55qE5Luj55CG44CB5Lik5LiqIE1DUCDnq6/ngrnlhajpg6jlnKjov5nkuIDkuKrnq6/lj6PkuIrmjInot6/lvoTljLrliIbvvIjnuqblrprlnKggYGFwcC1wYXRocy50c2DvvInjgILmtY/op4jlmajkuI5cbiAqIOe7iOerr+acjeWKoeacrOi6q+i3keWcqCBVbml4IHNvY2tldCDkuIrvvIzkuI3ljaAgVENQIOerr+WPo+OAguaJgOS7peOAjOaNouerr+WPo+OAjeWPquaUuei/memHjOS4gOWkhOOAglxuICpcbiAqIOerr+WPo+WPr+S7peiiqyBgTUlDQV9ERVNLVE9QX1BPUlRg77yI5oiW6L+Q6KGM5pe255qEIGAtLXBvcnRg77yJ6KaG55uW77yM6KKr5Yir55qE6L+b56iL5Y2g552A5pe26L+Y5Lya5Zue6YCA5YiwXG4gKiDpmo/mnLrnq6/lj6PigJTigJTlm6DmraTku7vkvZUqKuaLvOe7meeUqOaIt+eahOWcsOWdgCoq6YO96KaB5ou/6L+Q6KGM5pe25LiK5oql55qE5a6e6ZmF56uv5Y+j77yIYHJlYWR5YCDooYzjgIFgYWNjZXNzOmluZm9g77yJXG4gKiDnjrDmi7zvvIzkuI3og73lgYforr7pu5jorqTlgLzku43nhLbmiJDnq4vjgILov5nkuKrmqKHlnZflj6rmj5DkvpvluLjph4/jgIHpu5jorqTlgLzlkozjgIzmnKzmnLrlnLDlnYDjgI3ov5nkuIDlsYLnmoTmi7zms5XjgIJcbiAqXG4gKiDov5nph4zlkIzml7bmlLbnnYDlj6bkuIDkuKrni6znq4vlrr/kuLvnmoTpu5jorqTnq6/lj6PvvJpDb25maWcgV2Vi77yIYGFwcHMvY29uZmlnLXdlYmDvvIxgbWljYWAg5Zyo5rWP6KeI5Zmo6YeMXG4gKiDmiZPlvIDphY3nva7pobXml7bnlKjnmoTpgqPkuKogQnVuIOacjeWKoe+8ieOAguWug+WSjOahjOmdoui/kOihjOaXtuaYr+S4pOWll+i/m+eoi++8jOerr+WPo+WQhOiHqueLrOeri++8jOS9huWQjOagt+aYr1xuICog44CM5LiA5Liq6buY6K6k5YC8ICsg5LiA5Liq546v5aKD5Y+Y6YeP6KaG55uW44CN55qE5b2i5oCB77yM5omA5Lul5pS+5Zyo5LiA6LW377yM5Yir5YaN5b6A5ZCE6Ieq5Li75YWl5Y+j6YeM5oqE5a2X6Z2i6YeP44CCXG4gKlxuICog5Yi75oSP5YaZ5oiQ57qvIEpT77yI5bimIEpTRG9jIOexu+Wei++8ieiAjOS4jeaYryBgLnRzYO+8mnZpdGUg6YWN572u44CBYHNjcmlwdHMvKi5tanNgIOi/meS6m+eUqCBub2RlXG4gKiDnm7TmjqXot5HnmoTlhaXlj6PkuZ/opoHor7vlkIzkuIDku73luLjph4/vvIzlroPku6zoo4XkuI3kuoYgVFMg6L2s6K+R44CCXG4gKi9cblxuLyoqIOm7mOiupOerr+WPo++8muayoeacieS7u+S9lemFjee9ruaXtui/kOihjOaXtuebkeWQrOWug++8jOS5n+aYr+OAjOacrOacuuOAjei/meS4quWcsOWdgOeahOerr+WPo+OAgiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfUlVOVElNRV9QT1JUID0gODc4NztcblxuLyoqIOimhueblum7mOiupOerr+WPo+eahOWPmOmHj++8mui/kOihjOaXtuOAgUVsZWN0cm9uIOWkluWjs+OAgVZpdGUgZGV2IHNlcnZlciDnmoTku6PnkIbpg73or7vlkIzkuIDkuKrjgIIgKi9cbmV4cG9ydCBjb25zdCBSVU5USU1FX1BPUlRfRU5WID0gJ01JQ0FfREVTS1RPUF9QT1JUJztcblxuLyoqIENvbmZpZyBXZWIg55qE6buY6K6k56uv5Y+j77yIYGFwcHMvY29uZmlnLXdlYmDvvIzni6znq4vkuo7moYzpnaLov5DooYzml7bvvInjgIIgKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX0NPTkZJR19XRUJfUE9SVCA9IDEzOTg3O1xuXG4vKiog6KaG55uWIENvbmZpZyBXZWIg56uv5Y+j55qE5Y+Y6YeP44CCICovXG5leHBvcnQgY29uc3QgQ09ORklHX1dFQl9QT1JUX0VOViA9ICdNSUNBX0NPTkZJR19XRUJfUE9SVCc7XG5cbi8qKiDlm57njq/lnLDlnYDvvJrlpJblo7PjgIHpobXpnaLlkowgYWdlbnQg6YO95LuO6L+Z5Y+w5py65Zmo5LiK55qE6L+Z5Liq5Zyw5Z2A6L+b6L+Q6KGM5pe244CCICovXG5leHBvcnQgY29uc3QgUlVOVElNRV9MT09QQkFDS19IT1NUID0gJzEyNy4wLjAuMSc7XG5cbi8qKlxuICog5oqK56uv5Y+j5YC877yIZW52IOWtl+espuS4suOAgeWRveS7pOihjOWPguaVsOOAgeaVsOWtl++8ieino+aekOaIkOerr+WPo+WPt+OAglxuICpcbiAqIOmdnuazleWAvO+8iOepuuOAgeS4jeaYr+aVtOaVsOOAgei2heWHuiAxLTY1NTM177yJ5LiA5b6L6JC95ZueIGBmYWxsYmFja2DvvIzosIPnlKjmlrnkuI3nlKjlkIToh6rlhpnkuIDpgY1cbiAqIOOAjGBwYXJzZUludGAg5LmL5ZCO5YikIGBOYU5g44CN4oCU4oCU5Lul5YmN6L+Z5Yeg5aSE5bCx5piv6L+Z5LmI5YiG5Y+J55qE44CCXG4gKlxuICogQHBhcmFtIHt1bmtub3dufSB2YWx1ZVxuICogQHBhcmFtIHtudW1iZXJ9IFtmYWxsYmFja11cbiAqIEByZXR1cm5zIHtudW1iZXJ9XG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVJ1bnRpbWVQb3J0KHZhbHVlLCBmYWxsYmFjayA9IERFRkFVTFRfUlVOVElNRV9QT1JUKSB7XG4gIC8vIOaVsOWtl+ebtOaOpeWIpO+8m+Wtl+espuS4suimgeaxguaVtOS4sumDveaYr+aVsOWtl+KAlOKAlGBwYXJzZUludCgnMTIuNScpYC9gJzkwMDBhYmMnYCDkvJrmgoTmgoTmiKrlh7ogMTIg5ZKMIDkwMDDvvIxcbiAgLy8g6YKj56eN44CM5aGr6ZSZ5LqG5Y206L+Y6IO95ZCv5Yqo44CN5q+U55u05o6l6JC95Zue6buY6K6k5YC85pu06Zq+5p+l44CCXG4gIGNvbnN0IHRleHQgPSB0eXBlb2YgdmFsdWUgPT09ICdudW1iZXInID8gbnVsbCA6IFN0cmluZyh2YWx1ZSA/PyAnJykudHJpbSgpO1xuICBjb25zdCBwYXJzZWQgPSB0ZXh0ID09PSBudWxsID8gdmFsdWUgOiAvXlxcZCskLy50ZXN0KHRleHQpID8gTnVtYmVyKHRleHQpIDogTnVtYmVyLk5hTjtcbiAgaWYgKCFOdW1iZXIuaXNJbnRlZ2VyKHBhcnNlZCkgfHwgcGFyc2VkIDw9IDAgfHwgcGFyc2VkID4gNjU1MzUpIHJldHVybiBmYWxsYmFjaztcbiAgcmV0dXJuIHBhcnNlZDtcbn1cblxuLyoqXG4gKiDmn5DkuKrnq6/lj6PkuIrnmoTlm57njq/lnLDlnYDvvJrov5nlj7DmnLrlmajkuIrnmoTpgqPlj7Dov5DooYzml7bvvIzkuZ/lsLHmmK/nlYzpnaLph4znmoTjgIzmnKzmnLrjgI3jgIJcbiAqXG4gKiBAcGFyYW0ge251bWJlciB8IHN0cmluZ30gW3BvcnRdXG4gKiBAcmV0dXJucyB7c3RyaW5nfVxuICovXG5leHBvcnQgZnVuY3Rpb24gbG9vcGJhY2tSdW50aW1lVXJsKHBvcnQgPSBERUZBVUxUX1JVTlRJTUVfUE9SVCkge1xuICByZXR1cm4gYGh0dHA6Ly8ke1JVTlRJTUVfTE9PUEJBQ0tfSE9TVH06JHtwYXJzZVJ1bnRpbWVQb3J0KHBvcnQpfWA7XG59XG5cbi8qKiDpu5jorqTnq6/lj6PnmoTlm57njq/lnLDlnYDvvIznu5njgIzmsqHmnInphY3nva7ml7blsLHor6XmmK/ov5nkuKrjgI3nmoTosIPnlKjmlrnnlKjjgIIgKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1JVTlRJTUVfVVJMID0gbG9vcGJhY2tSdW50aW1lVXJsKCk7XG4iLCJpbXBvcnQgeyByZWFkRmlsZSwgcmVhZGRpciB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnXG5pbXBvcnQgeyBkaXJuYW1lLCBpc0Fic29sdXRlLCBqb2luLCByZWxhdGl2ZSwgc2VwIH0gZnJvbSAnbm9kZTpwYXRoJ1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCB9IGZyb20gJ25vZGU6dXJsJ1xuXG5jb25zdCBtYW5pZmVzdFBhdGggPSBmaWxlVVJMVG9QYXRoKFxuICBuZXcgVVJMKCcuLi9zcmMvcmVuZGVyZXIvc3JjL3ZzY29kZS1pY29ucy1tYW5pZmVzdC5qc29uJywgaW1wb3J0Lm1ldGEudXJsKVxuKVxuY29uc3QgaWNvbkRpciA9IGZpbGVVUkxUb1BhdGgobmV3IFVSTCgnLi4vc3JjL3JlbmRlcmVyL2Fzc2V0cy9maWxlLWljb25zJywgaW1wb3J0Lm1ldGEudXJsKSlcbmNvbnN0IHZpcnR1YWxJZCA9ICd2aXJ0dWFsOmZpbGUtaWNvbi1hc3NldHMnXG5jb25zdCByZXNvbHZlZFZpcnR1YWxJZCA9IGBcXDAke3ZpcnR1YWxJZH1gXG5cbi8vIEZpbGVJY29uIOeahOaWh+S7tuOAgeebruW9leOAgeWxleW8gOWSjOm7mOiupOWbvuagh+WbnumAgOmDveS9v+eUqOi/meS6m+WQjeensOOAgua4heWNleWPr+S7peW8leeUqOS4jeWtmOWcqOeahFxuLy8g54m55YyW5Zu+5qCH77ya5Y+q5pS25b2V5a6e6ZmF5a2Y5Zyo55qE5paH5Lu277yM6K6p57uE5Lu257un57ut5Zue6YCA5Yiw5pmu6YCa55uu5b2V5oiW6buY6K6k5Zu+5qCH44CCXG5mdW5jdGlvbiByZWFjaGFibGVJY29uTmFtZXMobWFuaWZlc3QpIHtcbiAgY29uc3QgbmFtZXMgPSBuZXcgU2V0KFtcbiAgICBgZGVmYXVsdF8ke21hbmlmZXN0LmRlZmF1bHRzLmZpbGV9YCxcbiAgICBgZGVmYXVsdF8ke21hbmlmZXN0LmRlZmF1bHRzLmZvbGRlcn1gLFxuICAgIGBkZWZhdWx0XyR7bWFuaWZlc3QuZGVmYXVsdHMuZm9sZGVyfV9vcGVuZWRgXG4gIF0pXG4gIGZvciAoY29uc3QgbmFtZSBvZiBbXG4gICAgLi4uT2JqZWN0LnZhbHVlcyhtYW5pZmVzdC5maWxlcyksXG4gICAgLi4uT2JqZWN0LnZhbHVlcyhtYW5pZmVzdC5leHRlbnNpb25zKSxcbiAgICBtYW5pZmVzdC5kZWZhdWx0cy5maWxlXG4gIF0pIHtcbiAgICBuYW1lcy5hZGQoYGZpbGVfdHlwZV8ke25hbWV9YClcbiAgfVxuICBmb3IgKGNvbnN0IG5hbWUgb2YgWy4uLk9iamVjdC52YWx1ZXMobWFuaWZlc3QuZm9sZGVycyksIG1hbmlmZXN0LmRlZmF1bHRzLmZvbGRlcl0pIHtcbiAgICBuYW1lcy5hZGQoYGZvbGRlcl90eXBlXyR7bmFtZX1gKVxuICAgIG5hbWVzLmFkZChgZm9sZGVyX3R5cGVfJHtuYW1lfV9vcGVuZWRgKVxuICB9XG4gIHJldHVybiBuYW1lc1xufVxuXG5mdW5jdGlvbiB1cmxQYXRoKHBhdGgpIHtcbiAgcmV0dXJuIHBhdGhcbiAgICAuc3BsaXQoc2VwKVxuICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAubWFwKChwYXJ0KSA9PiAoL15bQS1aYS16XTokLy50ZXN0KHBhcnQpID8gcGFydCA6IGVuY29kZVVSSUNvbXBvbmVudChwYXJ0KSkpXG4gICAgLmpvaW4oJy8nKVxufVxuXG5leHBvcnQgZnVuY3Rpb24gZmlsZUljb25Bc3NldHMoKSB7XG4gIGxldCBjb25maWdcblxuICByZXR1cm4ge1xuICAgIG5hbWU6ICdtaWNhOmZpbGUtaWNvbi1hc3NldHMnLFxuICAgIGNvbmZpZ1Jlc29sdmVkKHJlc29sdmVkKSB7XG4gICAgICBjb25maWcgPSByZXNvbHZlZFxuICAgIH0sXG4gICAgcmVzb2x2ZUlkKGlkKSB7XG4gICAgICByZXR1cm4gaWQgPT09IHZpcnR1YWxJZCA/IHJlc29sdmVkVmlydHVhbElkIDogbnVsbFxuICAgIH0sXG4gICAgYXN5bmMgbG9hZChpZCkge1xuICAgICAgaWYgKGlkICE9PSByZXNvbHZlZFZpcnR1YWxJZCkgcmV0dXJuIG51bGxcblxuICAgICAgdGhpcy5hZGRXYXRjaEZpbGUobWFuaWZlc3RQYXRoKVxuICAgICAgY29uc3QgbWFuaWZlc3QgPSBKU09OLnBhcnNlKGF3YWl0IHJlYWRGaWxlKG1hbmlmZXN0UGF0aCwgJ3V0ZjgnKSlcbiAgICAgIGNvbnN0IGF2YWlsYWJsZSA9IG5ldyBTZXQoYXdhaXQgcmVhZGRpcihpY29uRGlyKSlcbiAgICAgIGNvbnN0IG5hbWVzID0gWy4uLnJlYWNoYWJsZUljb25OYW1lcyhtYW5pZmVzdCldXG4gICAgICAgIC5maWx0ZXIoKG5hbWUpID0+IGF2YWlsYWJsZS5oYXMoYCR7bmFtZX0uc3ZnYCkpXG4gICAgICAgIC5zb3J0KClcblxuICAgICAgaWYgKGNvbmZpZy5jb21tYW5kID09PSAnc2VydmUnKSB7XG4gICAgICAgIC8vIOWbvuagh+S9jeS6jiByZW5kZXJlciByb290IOaXtueUsSBWaXRlIOmdmeaAgeacjeWKoeebtOaOpeaPkOS+m++8m+WFtuS7liByb290IOS9v+eUqCAvQGZzL+OAglxuICAgICAgICAvLyDkvb/nlKggVml0ZSDlt7Lop4TojIPljJbnmoQgYmFzZSDlkowgb3JpZ2lu77yM5YW85a655a2Q6Lev5b6E5LiO6L+c56iLIGRldiBzZXJ2ZXLjgIJcbiAgICAgICAgY29uc3QgZGlyRnJvbVJvb3QgPSByZWxhdGl2ZShjb25maWcucm9vdCwgaWNvbkRpcilcbiAgICAgICAgY29uc3QgaW5zaWRlUm9vdCA9XG4gICAgICAgICAgZGlyRnJvbVJvb3QgIT09ICcuLicgJiYgIWRpckZyb21Sb290LnN0YXJ0c1dpdGgoYC4uJHtzZXB9YCkgJiYgIWlzQWJzb2x1dGUoZGlyRnJvbVJvb3QpXG4gICAgICAgIGNvbnN0IHVybERpciA9IGluc2lkZVJvb3QgPyB1cmxQYXRoKGRpckZyb21Sb290KSA6IGBAZnMvJHt1cmxQYXRoKGljb25EaXIpfWBcbiAgICAgICAgY29uc3QgYmFzZSA9IGAkeyhjb25maWcuc2VydmVyLm9yaWdpbiB8fCAnJykucmVwbGFjZSgvXFwvJC8sICcnKX0ke2NvbmZpZy5iYXNlfWBcbiAgICAgICAgY29uc3QgZW50cmllcyA9IG5hbWVzLm1hcCgobmFtZSkgPT4gW1xuICAgICAgICAgIG5hbWUsXG4gICAgICAgICAgYCR7YmFzZX0ke3VybERpcn0vJHtlbmNvZGVVUklDb21wb25lbnQobmFtZSl9LnN2Z2BcbiAgICAgICAgXSlcbiAgICAgICAgcmV0dXJuIGBleHBvcnQgZGVmYXVsdCAke0pTT04uc3RyaW5naWZ5KE9iamVjdC5mcm9tRW50cmllcyhlbnRyaWVzKSl9YFxuICAgICAgfVxuXG4gICAgICAvLyDnm7TmjqXlj5Hlh7rmlofku7bvvIzpgb/lhY3miormr4/kuKogU1ZHIOW9k+aIkOS4gOS4qiBWaXRlIOaooeWdl+WkhOeQhu+8m1ZpdGUg55qEIGZpbGUgVVJMXG4gICAgICAvLyBob29rIOi0n+i0o+ebuOWvuSBiYXNlIOWSjOaWh+S7tiBoYXNo77yMRWxlY3Ryb24g5LiO56e75Yqo56uv6Z2Z5oCB5pyN5Yqh5YWx55So5ZCM5LiA5Lu95Lqn54mp44CCXG4gICAgICAvLyDpmZDliLblkIzml7bmiZPlvIDnmoTmlofku7bmlbDph4/vvIzpgb/lhY3lnKjmlofku7bmj4/ov7DnrKbkuIrpmZDovoPkvY7nmoTlvIDlj5HmnLrlmajkuIrop6blj5EgRU1GSUxF44CCXG4gICAgICBjb25zdCBzb3VyY2VzID0gW11cbiAgICAgIGZvciAobGV0IGluZGV4ID0gMDsgaW5kZXggPCBuYW1lcy5sZW5ndGg7IGluZGV4ICs9IDY0KSB7XG4gICAgICAgIGNvbnN0IGJhdGNoID0gbmFtZXMuc2xpY2UoaW5kZXgsIGluZGV4ICsgNjQpXG4gICAgICAgIGNvbnN0IGJhdGNoU291cmNlcyA9IGF3YWl0IFByb21pc2UuYWxsKFxuICAgICAgICAgIGJhdGNoLm1hcChhc3luYyAobmFtZSkgPT4ge1xuICAgICAgICAgICAgY29uc3QgcGF0aCA9IGpvaW4oaWNvbkRpciwgYCR7bmFtZX0uc3ZnYClcbiAgICAgICAgICAgIHRoaXMuYWRkV2F0Y2hGaWxlKHBhdGgpXG4gICAgICAgICAgICByZXR1cm4gcmVhZEZpbGUocGF0aClcbiAgICAgICAgICB9KVxuICAgICAgICApXG4gICAgICAgIHNvdXJjZXMucHVzaCguLi5iYXRjaFNvdXJjZXMpXG4gICAgICB9XG4gICAgICBpZiAoY29uZmlnLmJ1aWxkLndhdGNoKSB0aGlzLmFkZFdhdGNoRmlsZShpY29uRGlyKVxuICAgICAgY29uc3QgZW50cmllcyA9IG5hbWVzLm1hcCgobmFtZSwgaW5kZXgpID0+IHtcbiAgICAgICAgY29uc3QgcmVmID0gdGhpcy5lbWl0RmlsZSh7IHR5cGU6ICdhc3NldCcsIG5hbWU6IGAke25hbWV9LnN2Z2AsIHNvdXJjZTogc291cmNlc1tpbmRleF0gfSlcbiAgICAgICAgcmV0dXJuIGAke0pTT04uc3RyaW5naWZ5KG5hbWUpfTogaW1wb3J0Lm1ldGEuUk9MTERPV05fRklMRV9VUkxfJHtyZWZ9YFxuICAgICAgfSlcbiAgICAgIHJldHVybiBgZXhwb3J0IGRlZmF1bHQgeyR7ZW50cmllcy5qb2luKCcsJyl9fWBcbiAgICB9LFxuICAgIGNvbmZpZ3VyZVNlcnZlcihzZXJ2ZXIpIHtcbiAgICAgIC8vIOebtOaOpSBVUkwg5rKh5pyJIFNWRyDmqKHlnZfkvp3otZbvvJvmlrDlop7jgIHliKDpmaTmiJbnvJbovpHlm77moIflkI7liLfmlrDpobXpnaLlubbph43lu7rmmKDlsITvvIxcbiAgICAgIC8vIOiuqeW8gOWPkeaXtueahOWbnumAgOWSjOi1hOa6kOabtOaWsOS7jeeEtueri+WNs+eUn+aViOOAgua4heWNleWPmOabtOeUsSBhZGRXYXRjaEZpbGUg6Lef6Liq44CCXG4gICAgICBzZXJ2ZXIud2F0Y2hlci5hZGQoaWNvbkRpcilcbiAgICAgIHNlcnZlci53YXRjaGVyLm9uKCdhbGwnLCAoZXZlbnQsIGZpbGUpID0+IHtcbiAgICAgICAgaWYgKFxuICAgICAgICAgICFbJ2FkZCcsICdjaGFuZ2UnLCAndW5saW5rJ10uaW5jbHVkZXMoZXZlbnQpIHx8XG4gICAgICAgICAgZGlybmFtZShmaWxlKS5yZXBsYWNlQWxsKCdcXFxcJywgJy8nKSAhPT0gaWNvbkRpci5yZXBsYWNlQWxsKCdcXFxcJywgJy8nKSB8fFxuICAgICAgICAgICFmaWxlLmVuZHNXaXRoKCcuc3ZnJylcbiAgICAgICAgKVxuICAgICAgICAgIHJldHVyblxuICAgICAgICBjb25zdCBtb2R1bGUgPSBzZXJ2ZXIubW9kdWxlR3JhcGguZ2V0TW9kdWxlQnlJZChyZXNvbHZlZFZpcnR1YWxJZClcbiAgICAgICAgaWYgKCFtb2R1bGUpIHJldHVyblxuICAgICAgICBzZXJ2ZXIubW9kdWxlR3JhcGguaW52YWxpZGF0ZU1vZHVsZShtb2R1bGUpXG4gICAgICAgIHNlcnZlci53cy5zZW5kKHsgdHlwZTogJ2Z1bGwtcmVsb2FkJyB9KVxuICAgICAgfSlcbiAgICB9XG4gIH1cbn1cbiIsImltcG9ydCB7IHJlYWRkaXIsIHJlYWRGaWxlLCBta2RpciB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnXG5pbXBvcnQgeyBkaXJuYW1lLCBqb2luLCByZXNvbHZlIH0gZnJvbSAnbm9kZTpwYXRoJ1xuaW1wb3J0IHsgcGF0aFRvRmlsZVVSTCwgZmlsZVVSTFRvUGF0aCB9IGZyb20gJ25vZGU6dXJsJ1xuXG5jb25zdCBwbHVnaW5zUm9vdCA9IGZpbGVVUkxUb1BhdGgobmV3IFVSTCgnLi4vLi4vLi4vcGx1Z2lucy8nLCBpbXBvcnQubWV0YS51cmwpKVxuY29uc3QgcHJlZml4ID0gJy9wbHVnaW4td2ViLydcblxuLyoqXG4gKiDpmpTnprsgV2ViIOi/kOihjOaXtueahOmAmueUqOaehOW7uuWFpeWPo+OAguaPkuS7tuWPqumhu+aPkOS+myB3ZWItYnVpbGQubWpz77yM5LiN5Zyo5a6/5Li755m76K6w5Lia5Yqh5ZCN6K+N44CCXG4gKiDkuqfnianku43lsZ7kuo4gcmVuZGVyZXIg6Z2Z5oCB6LWE5rqQ77yM55Sx5pei5pyJIEhUVFAg5pyN5Yqh5omY566h77yb56ys5LiJ5pa55L6d6LWW562W55Wl55Sx5o+S5Lu26Ieq6KGM5Yaz5a6a44CCXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbHVnaW5XZWJBc3NldHMoKSB7XG4gIGxldCBjb25maWdcbiAgY29uc3QgYnVpbGRzID0gbmV3IE1hcCgpXG4gIGxldCBkZXZSb290XG4gIGFzeW5jIGZ1bmN0aW9uIGJ1aWxkZXJzKCkge1xuICAgIHJldHVybiAoYXdhaXQgcmVhZGRpcihwbHVnaW5zUm9vdCwgeyB3aXRoRmlsZVR5cGVzOiB0cnVlIH0pKVxuICAgICAgLmZpbHRlcigoZW50cnkpID0+IGVudHJ5LmlzRGlyZWN0b3J5KCkpXG4gICAgICAubWFwKChlbnRyeSkgPT4gZW50cnkubmFtZSlcbiAgICAgIC5maWx0ZXIoKG5hbWUpID0+IC9eW2EtejAtOV1bYS16MC05Ll8tXSokLy50ZXN0KG5hbWUpKVxuICB9XG4gIGFzeW5jIGZ1bmN0aW9uIGJ1aWxkT25lKGlkLCByb290KSB7XG4gICAgY29uc3Qgc2NyaXB0ID0gam9pbihwbHVnaW5zUm9vdCwgaWQsICd3ZWItYnVpbGQubWpzJylcbiAgICB0cnkgeyBhd2FpdCByZWFkRmlsZShzY3JpcHQpIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICBpZiAoZXJyb3IuY29kZSA9PT0gJ0VOT0VOVCcpIHJldHVybiBmYWxzZVxuICAgICAgdGhyb3cgZXJyb3JcbiAgICB9XG4gICAgY29uc3QgbW9kdWxlID0gYXdhaXQgaW1wb3J0KHBhdGhUb0ZpbGVVUkwoc2NyaXB0KS5ocmVmKVxuICAgIGNvbnN0IG91dERpciA9IGpvaW4ocm9vdCwgaWQpXG4gICAgYXdhaXQgbWtkaXIoZGlybmFtZShvdXREaXIpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KVxuICAgIGF3YWl0IG1vZHVsZS5kZWZhdWx0KHsgb3V0RGlyIH0pXG4gICAgcmV0dXJuIHRydWVcbiAgfVxuICByZXR1cm4ge1xuICAgIG5hbWU6ICdtaWNhOnBsdWdpbi13ZWItYXNzZXRzJyxcbiAgICBjb25maWdSZXNvbHZlZCh2YWx1ZSkgeyBjb25maWcgPSB2YWx1ZSB9LFxuICAgIGFzeW5jIGNsb3NlQnVuZGxlKCkge1xuICAgICAgaWYgKGNvbmZpZy5jb21tYW5kICE9PSAnYnVpbGQnKSByZXR1cm5cbiAgICAgIGNvbnN0IHJvb3QgPSByZXNvbHZlKGNvbmZpZy5yb290LCBjb25maWcuYnVpbGQub3V0RGlyLCAncGx1Z2luLXdlYicpXG4gICAgICBmb3IgKGNvbnN0IGlkIG9mIGF3YWl0IGJ1aWxkZXJzKCkpIGF3YWl0IGJ1aWxkT25lKGlkLCByb290KVxuICAgIH0sXG4gICAgY29uZmlndXJlU2VydmVyKHNlcnZlcikge1xuICAgICAgZGV2Um9vdCA9IGZpbGVVUkxUb1BhdGgobmV3IFVSTCgnLi4vLi4vLi4vdGVtcC9wbHVnaW4td2ViLWRldi8nLCBpbXBvcnQubWV0YS51cmwpKVxuICAgICAgc2VydmVyLm1pZGRsZXdhcmVzLnVzZShhc3luYyAocmVxLCByZXMsIG5leHQpID0+IHtcbiAgICAgICAgY29uc3QgcGF0aCA9IG5ldyBVUkwocmVxLnVybCwgJ2h0dHA6Ly9sb2NhbGhvc3QnKS5wYXRobmFtZVxuICAgICAgICBpZiAoIXBhdGguc3RhcnRzV2l0aChwcmVmaXgpKSByZXR1cm4gbmV4dCgpXG4gICAgICAgIGNvbnN0IFssIGlkLCAuLi5lbmNvZGVkUGFydHNdID0gcGF0aC5zbGljZSgnL3BsdWdpbi13ZWInLmxlbmd0aCkuc3BsaXQoJy8nKVxuICAgICAgICBsZXQgcGFydHNcbiAgICAgICAgdHJ5IHsgcGFydHMgPSBlbmNvZGVkUGFydHMubWFwKGRlY29kZVVSSUNvbXBvbmVudCkgfSBjYXRjaCB7IHJldHVybiBuZXh0KCkgfVxuICAgICAgICBpZiAoIS9eW2EtejAtOV1bYS16MC05Ll8tXSokLy50ZXN0KGlkIHx8ICcnKSB8fCBwYXJ0cy5zb21lKChwYXJ0KSA9PiBwYXJ0ID09PSAnLi4nIHx8IHBhcnQuaW5jbHVkZXMoJy8nKSB8fCBwYXJ0LmluY2x1ZGVzKCdcXFxcJykpKSByZXR1cm4gbmV4dCgpXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgaWYgKCFidWlsZHMuaGFzKGlkKSkgYnVpbGRzLnNldChpZCwgYnVpbGRPbmUoaWQsIGRldlJvb3QpKVxuICAgICAgICAgIGlmICghKGF3YWl0IGJ1aWxkcy5nZXQoaWQpKSkgcmV0dXJuIG5leHQoKVxuICAgICAgICAgIGNvbnN0IGFzc2V0ID0gcmVzb2x2ZShkZXZSb290LCBpZCwgcGFydHMuam9pbignLycpIHx8ICdpbmRleC5odG1sJylcbiAgICAgICAgICBpZiAoIWFzc2V0LnN0YXJ0c1dpdGgocmVzb2x2ZShkZXZSb290LCBpZCkgKyAnLycpKSByZXR1cm4gbmV4dCgpXG4gICAgICAgICAgY29uc3QgYnl0ZXMgPSBhd2FpdCByZWFkRmlsZShhc3NldClcbiAgICAgICAgICBjb25zdCB0eXBlcyA9IHsgaHRtbDogJ3RleHQvaHRtbCcsIGpzOiAndGV4dC9qYXZhc2NyaXB0JywgY3NzOiAndGV4dC9jc3MnLCBzdmc6ICdpbWFnZS9zdmcreG1sJywgd29mZjI6ICdmb250L3dvZmYyJyB9XG4gICAgICAgICAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgdHlwZXNbYXNzZXQuc3BsaXQoJy4nKS5wb3AoKV0gfHwgJ2FwcGxpY2F0aW9uL29jdGV0LXN0cmVhbScpXG4gICAgICAgICAgcmVzLnNldEhlYWRlcignQWNjZXNzLUNvbnRyb2wtQWxsb3ctT3JpZ2luJywgJyonKVxuICAgICAgICAgIHJlcy5zZXRIZWFkZXIoJ0NhY2hlLUNvbnRyb2wnLCAnbm8tc3RvcmUnKVxuICAgICAgICAgIHJlcy5lbmQoYnl0ZXMpXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgYnVpbGRzLmRlbGV0ZShpZClcbiAgICAgICAgICBpZiAoZXJyb3IuY29kZSA9PT0gJ0VOT0VOVCcpIHJldHVybiBuZXh0KClcbiAgICAgICAgICBzZXJ2ZXIuY29uZmlnLmxvZ2dlci5lcnJvcihTdHJpbmcoZXJyb3Iuc3RhY2sgfHwgZXJyb3IpKVxuICAgICAgICAgIHJlcy5zdGF0dXNDb2RlID0gNTAwXG4gICAgICAgICAgcmVzLmVuZCgn5o+S5Lu26aG16Z2i5p6E5bu65aSx6LSl77yM6K+35qOA5p+l5byA5Y+R5pyN5Yqh5pel5b+XJylcbiAgICAgICAgfVxuICAgICAgfSlcbiAgICAgIHNlcnZlci53YXRjaGVyLm9uKCdjaGFuZ2UnLCAoZmlsZSkgPT4ge1xuICAgICAgICBpZiAoIWZpbGUuc3RhcnRzV2l0aChwbHVnaW5zUm9vdCkpIHJldHVyblxuICAgICAgICBjb25zdCBpZCA9IGZpbGUuc2xpY2UocGx1Z2luc1Jvb3QubGVuZ3RoKS5zcGxpdCgnLycpWzBdXG4gICAgICAgIGlmIChmaWxlLmluY2x1ZGVzKCcvZWRpdG9yLycpKSBidWlsZHMuZGVsZXRlKGlkKVxuICAgICAgfSlcbiAgICB9XG4gIH1cbn1cbiIsImltcG9ydCB7IHJlYWRGaWxlLCByZWFscGF0aCB9IGZyb20gJ25vZGU6ZnMvcHJvbWlzZXMnXG5pbXBvcnQgeyBjcmVhdGVSZXF1aXJlIH0gZnJvbSAnbm9kZTptb2R1bGUnXG5pbXBvcnQgeyBleHRuYW1lLCByZWxhdGl2ZSwgcmVzb2x2ZSwgc2VwIH0gZnJvbSAnbm9kZTpwYXRoJ1xuaW1wb3J0IHsgZmlsZVVSTFRvUGF0aCwgcGF0aFRvRmlsZVVSTCB9IGZyb20gJ25vZGU6dXJsJ1xuXG5jb25zdCBydW50aW1lUm9vdCA9IGZpbGVVUkxUb1BhdGgobmV3IFVSTCgnLi9ydW50aW1lLycsIGltcG9ydC5tZXRhLnVybCkpXG5jb25zdCB0aGVtZUZpbGUgPSBmaWxlVVJMVG9QYXRoKG5ldyBVUkwoJy4uL21pY2EtY29uZmlnLXVpL3dlYi9hcmNvLXNldHRpbmdzLmNzcycsIGltcG9ydC5tZXRhLnVybCkpXG5jb25zdCBkZXZSb290ID0gZmlsZVVSTFRvUGF0aChuZXcgVVJMKCcuLi8uLi90ZW1wL2VkaXRvci13ZWItZGV2LycsIGltcG9ydC5tZXRhLnVybCkpXG5jb25zdCBydW50aW1lUmVxdWlyZSA9IGNyZWF0ZVJlcXVpcmUobmV3IFVSTCgnLi9ydW50aW1lL3BhY2thZ2UuanNvbicsIGltcG9ydC5tZXRhLnVybCkpXG5jb25zdCBwcmVmaXggPSAnL2VkaXRvci8nXG5jb25zdCBjb250ZW50VHlwZXMgPSB7XG4gICcuaHRtbCc6ICd0ZXh0L2h0bWw7IGNoYXJzZXQ9dXRmLTgnLFxuICAnLmpzJzogJ3RleHQvamF2YXNjcmlwdDsgY2hhcnNldD11dGYtOCcsXG4gICcubWpzJzogJ3RleHQvamF2YXNjcmlwdDsgY2hhcnNldD11dGYtOCcsXG4gICcuY3NzJzogJ3RleHQvY3NzOyBjaGFyc2V0PXV0Zi04JyxcbiAgJy5qc29uJzogJ2FwcGxpY2F0aW9uL2pzb247IGNoYXJzZXQ9dXRmLTgnLFxuICAnLm1hcCc6ICdhcHBsaWNhdGlvbi9qc29uOyBjaGFyc2V0PXV0Zi04JyxcbiAgJy5zdmcnOiAnaW1hZ2Uvc3ZnK3htbCcsXG4gICcucG5nJzogJ2ltYWdlL3BuZycsXG4gICcuanBnJzogJ2ltYWdlL2pwZWcnLFxuICAnLmpwZWcnOiAnaW1hZ2UvanBlZycsXG4gICcuZ2lmJzogJ2ltYWdlL2dpZicsXG4gICcud2VicCc6ICdpbWFnZS93ZWJwJyxcbiAgJy5pY28nOiAnaW1hZ2UveC1pY29uJyxcbiAgJy53b2ZmJzogJ2ZvbnQvd29mZicsXG4gICcud29mZjInOiAnZm9udC93b2ZmMicsXG4gICcudHRmJzogJ2ZvbnQvdHRmJyxcbiAgJy53ZWJtYW5pZmVzdCc6ICdhcHBsaWNhdGlvbi9tYW5pZmVzdCtqc29uOyBjaGFyc2V0PXV0Zi04JyxcbiAgJy50eHQnOiAndGV4dC9wbGFpbjsgY2hhcnNldD11dGYtOCdcbn1cblxuLyoqIEJ1aWxkIHRoZSBvbmUgaXNvbGF0ZWQgcnVudGltZSB3aXRoIGl0cyBvd24gcGlubmVkIGRldmVsb3BtZW50IHRvb2xjaGFpbi4gKi9cbmV4cG9ydCBkZWZhdWx0IGFzeW5jIGZ1bmN0aW9uIGJ1aWxkRWRpdG9yQXNzZXRzKHsgb3V0RGlyIH0pIHtcbiAgY29uc3QgeyBidWlsZCB9ID0gYXdhaXQgaW1wb3J0KHBhdGhUb0ZpbGVVUkwocnVudGltZVJlcXVpcmUucmVzb2x2ZSgndml0ZScpKS5ocmVmKVxuICBhd2FpdCBidWlsZCh7XG4gICAgY29uZmlnRmlsZTogcmVzb2x2ZShydW50aW1lUm9vdCwgJ3ZpdGUuY29uZmlnLm1qcycpLFxuICAgIGJ1aWxkOiB7IG91dERpcjogcmVzb2x2ZShvdXREaXIpLCBlbXB0eU91dERpcjogdHJ1ZSB9XG4gIH0pXG59XG5cbi8qKiBCb3RoIGJyb3dzZXIgaG9zdHMgc2VydmUgdGhlIHNhbWUgL2VkaXRvci8gYXNzZXRzOyBubyBwbHVnaW4gb3ducyB0aGlzIGJ1aWxkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGVkaXRvcldlYkFzc2V0cygpIHtcbiAgbGV0IGNvbmZpZ1xuICBsZXQgcGVuZGluZ0J1aWxkXG4gIGxldCByZXZpc2lvbiA9IDBcbiAgbGV0IGJ1aWx0UmV2aXNpb24gPSAtMVxuICBsZXQgc3RvcFdhdGNoaW5nXG5cbiAgYXN5bmMgZnVuY3Rpb24gZW5zdXJlRGV2QnVpbGQoKSB7XG4gICAgLy8gQSBzb3VyY2UgY2hhbmdlIGR1cmluZyBhIGJ1aWxkIG5lZWRzIGEgc2Vjb25kIGJ1aWxkLCBuZXZlciBwYXJhbGxlbCB3cml0ZXJzLlxuICAgIHdoaWxlIChidWlsdFJldmlzaW9uICE9PSByZXZpc2lvbikge1xuICAgICAgaWYgKCFwZW5kaW5nQnVpbGQpIHtcbiAgICAgICAgY29uc3QgYnVpbGRpbmdSZXZpc2lvbiA9IHJldmlzaW9uXG4gICAgICAgIHBlbmRpbmdCdWlsZCA9IGJ1aWxkRWRpdG9yQXNzZXRzKHsgb3V0RGlyOiBkZXZSb290IH0pXG4gICAgICAgICAgLnRoZW4oKCkgPT4geyBidWlsdFJldmlzaW9uID0gYnVpbGRpbmdSZXZpc2lvbiB9KVxuICAgICAgICAgIC5maW5hbGx5KCgpID0+IHsgcGVuZGluZ0J1aWxkID0gdW5kZWZpbmVkIH0pXG4gICAgICB9XG4gICAgICBhd2FpdCBwZW5kaW5nQnVpbGRcbiAgICB9XG4gIH1cblxuICByZXR1cm4ge1xuICAgIG5hbWU6ICdtaWNhOmVkaXRvci13ZWItYXNzZXRzJyxcbiAgICBjb25maWdSZXNvbHZlZCh2YWx1ZSkgeyBjb25maWcgPSB2YWx1ZSB9LFxuICAgIGFzeW5jIGNsb3NlQnVuZGxlKCkge1xuICAgICAgc3RvcFdhdGNoaW5nPy4oKVxuICAgICAgaWYgKGNvbmZpZy5jb21tYW5kICE9PSAnYnVpbGQnKSByZXR1cm5cbiAgICAgIGF3YWl0IGJ1aWxkRWRpdG9yQXNzZXRzKHsgb3V0RGlyOiByZXNvbHZlKGNvbmZpZy5yb290LCBjb25maWcuYnVpbGQub3V0RGlyLCAnZWRpdG9yJykgfSlcbiAgICB9LFxuICAgIGNvbmZpZ3VyZVNlcnZlcihzZXJ2ZXIpIHtcbiAgICAgIGNvbnN0IGludmFsaWRhdGUgPSAoX2V2ZW50LCBmaWxlKSA9PiB7XG4gICAgICAgIGNvbnN0IHBhdGggPSByZXNvbHZlKGZpbGUpXG4gICAgICAgIGNvbnN0IHBhcnRzID0gcmVsYXRpdmUocnVudGltZVJvb3QsIHBhdGgpLnNwbGl0KHNlcClcbiAgICAgICAgaWYgKHBhdGggIT09IHRoZW1lRmlsZSAmJiAoIXBhdGguc3RhcnRzV2l0aChydW50aW1lUm9vdCkgfHwgcGFydHMuc29tZSgocGFydCkgPT4gWydub2RlX21vZHVsZXMnLCAnZGlzdCcsICdjb3ZlcmFnZScsICcudml0ZSddLmluY2x1ZGVzKHBhcnQpKSkpIHJldHVyblxuICAgICAgICByZXZpc2lvbiArPSAxXG4gICAgICB9XG4gICAgICBzZXJ2ZXIud2F0Y2hlci5hZGQoW3J1bnRpbWVSb290LCB0aGVtZUZpbGVdKVxuICAgICAgc2VydmVyLndhdGNoZXIub24oJ2FsbCcsIGludmFsaWRhdGUpXG4gICAgICBzdG9wV2F0Y2hpbmcgPSAoKSA9PiBzZXJ2ZXIud2F0Y2hlci5vZmYoJ2FsbCcsIGludmFsaWRhdGUpXG5cbiAgICAgIHNlcnZlci5taWRkbGV3YXJlcy51c2UoYXN5bmMgKHJlcSwgcmVzLCBuZXh0KSA9PiB7XG4gICAgICAgIC8vIEtlZXAgdGhlIHJhdyBwYXRobmFtZTogVVJMKCkgbm9ybWFsaXplcyBkb3Qgc2VnbWVudHMgYmVmb3JlIHZhbGlkYXRpb24uXG4gICAgICAgIGNvbnN0IHBhdGhuYW1lID0gKHJlcS51cmwgfHwgJycpLnNwbGl0KC9bPyNdLywgMSlbMF1cbiAgICAgICAgaWYgKHBhdGhuYW1lICE9PSAnL2VkaXRvcicgJiYgIXBhdGhuYW1lLnN0YXJ0c1dpdGgocHJlZml4KSkgcmV0dXJuIG5leHQoKVxuICAgICAgICByZXMuc2V0SGVhZGVyKCdBY2Nlc3MtQ29udHJvbC1BbGxvdy1PcmlnaW4nLCAnKicpXG4gICAgICAgIHJlcy5zZXRIZWFkZXIoJ0NhY2hlLUNvbnRyb2wnLCAnbm8tc3RvcmUnKVxuICAgICAgICByZXMuc2V0SGVhZGVyKCdYLUNvbnRlbnQtVHlwZS1PcHRpb25zJywgJ25vc25pZmYnKVxuICAgICAgICBjb25zdCBmYWlsID0gKHN0YXR1cywgbWVzc2FnZSkgPT4ge1xuICAgICAgICAgIHJlcy5zdGF0dXNDb2RlID0gc3RhdHVzXG4gICAgICAgICAgcmVzLnNldEhlYWRlcignQ29udGVudC1UeXBlJywgJ3RleHQvcGxhaW47IGNoYXJzZXQ9dXRmLTgnKVxuICAgICAgICAgIHJlcy5lbmQocmVxLm1ldGhvZCA9PT0gJ0hFQUQnID8gdW5kZWZpbmVkIDogbWVzc2FnZSlcbiAgICAgICAgfVxuICAgICAgICBpZiAocmVxLm1ldGhvZCAhPT0gJ0dFVCcgJiYgcmVxLm1ldGhvZCAhPT0gJ0hFQUQnKSB7XG4gICAgICAgICAgcmVzLnNldEhlYWRlcignQWxsb3cnLCAnR0VULCBIRUFEJylcbiAgICAgICAgICByZXR1cm4gZmFpbCg0MDUsICdNZXRob2Qgbm90IGFsbG93ZWQnKVxuICAgICAgICB9XG4gICAgICAgIGxldCBwYXJ0c1xuICAgICAgICB0cnkgeyBwYXJ0cyA9IHBhdGhuYW1lLnNsaWNlKHByZWZpeC5sZW5ndGgpLnNwbGl0KCcvJykubWFwKGRlY29kZVVSSUNvbXBvbmVudCkgfSBjYXRjaCB7IHJldHVybiBmYWlsKDQwNCwgJ05vdCBmb3VuZCcpIH1cbiAgICAgICAgaWYgKHBhcnRzLnNvbWUoKHBhcnQpID0+IHBhcnQgPT09ICcuLicgfHwgcGFydCA9PT0gJy4nIHx8IC9bL1xcXFxcXHgwMC1cXHgxZlxceDdmXS8udGVzdChwYXJ0KSkpIHJldHVybiBmYWlsKDQwNCwgJ05vdCBmb3VuZCcpXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgZW5zdXJlRGV2QnVpbGQoKVxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgIHNlcnZlci5jb25maWcubG9nZ2VyLmVycm9yKFN0cmluZyhlcnJvci5zdGFjayB8fCBlcnJvcikpXG4gICAgICAgICAgcmV0dXJuIGZhaWwoNTAwLCAn57yW6L6R5Zmo6aG16Z2i5p6E5bu65aSx6LSl77yM6K+35qOA5p+l5byA5Y+R5pyN5Yqh5pel5b+XJylcbiAgICAgICAgfVxuICAgICAgICB0cnkge1xuICAgICAgICAgIGNvbnN0IHJvb3QgPSBhd2FpdCByZWFscGF0aChkZXZSb290KVxuICAgICAgICAgIGNvbnN0IGFzc2V0ID0gYXdhaXQgcmVhbHBhdGgocmVzb2x2ZShyb290LCBwYXJ0cy5qb2luKCcvJykgfHwgJ2luZGV4Lmh0bWwnKSlcbiAgICAgICAgICBpZiAoIWFzc2V0LnN0YXJ0c1dpdGgocm9vdCArIHNlcCkpIHJldHVybiBmYWlsKDQwNCwgJ05vdCBmb3VuZCcpXG4gICAgICAgICAgY29uc3QgYnl0ZXMgPSBhd2FpdCByZWFkRmlsZShhc3NldClcbiAgICAgICAgICByZXMuc2V0SGVhZGVyKCdDb250ZW50LVR5cGUnLCBjb250ZW50VHlwZXNbZXh0bmFtZShhc3NldCkudG9Mb3dlckNhc2UoKV0gfHwgJ2FwcGxpY2F0aW9uL29jdGV0LXN0cmVhbScpXG4gICAgICAgICAgcmVzLnNldEhlYWRlcignQ29udGVudC1MZW5ndGgnLCBieXRlcy5ieXRlTGVuZ3RoKVxuICAgICAgICAgIHJlcy5lbmQocmVxLm1ldGhvZCA9PT0gJ0hFQUQnID8gdW5kZWZpbmVkIDogYnl0ZXMpXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgaWYgKFsnRU5PRU5UJywgJ0VOT1RESVInLCAnRUlTRElSJ10uaW5jbHVkZXMoZXJyb3IuY29kZSkpIHJldHVybiBmYWlsKDQwNCwgJ05vdCBmb3VuZCcpXG4gICAgICAgICAgc2VydmVyLmNvbmZpZy5sb2dnZXIuZXJyb3IoU3RyaW5nKGVycm9yLnN0YWNrIHx8IGVycm9yKSlcbiAgICAgICAgICBmYWlsKDUwMCwgJ+e8lui+keWZqOi1hOa6kOivu+WPluWksei0pe+8jOivt+ajgOafpeW8gOWPkeacjeWKoeaXpeW/lycpXG4gICAgICAgIH1cbiAgICAgIH0pXG4gICAgfVxuICB9XG59XG4iLCJpbXBvcnQgeyBkZWZpbmVDb25maWcsIGV4dGVybmFsaXplRGVwc1BsdWdpbiB9IGZyb20gJ2VsZWN0cm9uLXZpdGUnXG5pbXBvcnQgdGFpbHdpbmRjc3MgZnJvbSAnQHRhaWx3aW5kY3NzL3ZpdGUnXG5pbXBvcnQgeyBSVU5USU1FX1BPUlRfRU5WLCBwYXJzZVJ1bnRpbWVQb3J0IH0gZnJvbSAnLi4vLi4vcGFja2FnZXMvbWljYS13ZWItc2hhcmVkL3J1bnRpbWUtcG9ydC5qcydcbmltcG9ydCByZWFjdCBmcm9tICdAdml0ZWpzL3BsdWdpbi1yZWFjdCdcbmltcG9ydCB7IHJlc29sdmUgfSBmcm9tICdwYXRoJ1xuaW1wb3J0IHsgZmlsZUljb25Bc3NldHMgfSBmcm9tICcuL3NjcmlwdHMvZmlsZS1pY29uLWFzc2V0cy5tanMnXG5pbXBvcnQgeyBwbHVnaW5XZWJBc3NldHMgfSBmcm9tICcuL3NjcmlwdHMvcGx1Z2luLXdlYi1hc3NldHMubWpzJ1xuaW1wb3J0IHsgZWRpdG9yV2ViQXNzZXRzIH0gZnJvbSAnLi9zY3JpcHRzL2VkaXRvci13ZWItYXNzZXRzLm1qcydcblxuLyoqXG4gKiDlupTnlKjnmoTov5DooYzml7bmmK8gV2ViIOmhtemdou+8iOeUsSB2aXRlLnNlcnZlci5jb25maWcubWpzIOaehOW7uueahCBvdXQvc2VydmVyIOaJmOeuoe+8ie+8jFxuICog6L+Z6YeM5Y+q5p6E5bu6IEVsZWN0cm9uIOWkluWjsyBtYWluIOWSjCByZW5kZXJlciDpobXpnaLmnKzouqvjgIJcbiAqXG4gKiBkZXYg5LiL6aG16Z2i6LWwIFZpdGUgZGV2IHNlcnZlcu+8iEhNUu+8ie+8jOi/kOihjOaXtuWPpuihjOWQr+WKqO+8jOWboOatpOaKiiAvYXBpIOS7o+eQhuWIsOWug++8jFxuICog6K6p6aG16Z2i5Zyo5Lik56eN5qih5byP5LiL6YO95L+d5oyB5ZCM5rqQ6LCD55So44CC56uv5Y+j5LiO5aSW5aOz5LiA6Ie077yITUlDQV9ERVNLVE9QX1BPUlQg5Y+v6KaG55uW77yJ44CCXG4gKlxuICogcHJlbG9hZCDlj6rmj5DkvpvlrqLmiLfnq6/kuJPlsZ7og73lipvvvIjmnKzmnLrmj5Lku7bmlbDmja7jgIHmjqLmtLvlkoznqpflj6PliIfmjaLvvInvvJvov5DooYzml7bkuJrliqHku43otbAgSFRUUCArIFNTReOAglxuICovXG4vLyBkZXYg5Luj55CG6KaB6JC95Yiw6L+Q6KGM5pe26YKj5Liq56uv5Y+j5LiK77ya56uv5Y+j5bi46YeP55qE5ZSv5LiA5p2l5rqQ5pivIG1pY2Etd2ViLXNoYXJlZCDnmoQgcnVudGltZS1wb3J077yMXG4vLyDov5nph4zkuI3lho3mioTkuIDku70gODc4N1xuY29uc3QgcnVudGltZVBvcnQgPSBwYXJzZVJ1bnRpbWVQb3J0KHByb2Nlc3MuZW52W1JVTlRJTUVfUE9SVF9FTlZdKVxuXG4vKipcbiAqIOaKiiBgaW1wb3J0IHsgSWNvblgsIEljb25ZIH0gZnJvbSAnQHRhYmxlci9pY29ucy1yZWFjdCdgIOaUueWGmeaIkOmAkOS4qua3sei3r+W+hOWvvOWFpeOAglxuICpcbiAqIOS4iua4uOWMheeahCBiYXJyZWzvvIhkaXN0L2VzbS90YWJsZXItaWNvbnMtcmVhY3QubWpz77yJ6Zmk5LqGIHJlLWV4cG9ydCDlhajpg6ggNjE5NyDkuKrlm77moIfmqKHlnZfvvIxcbiAqIOi/mOS8miBgaW1wb3J0ICogYXMgaW5kZXggZnJvbSAnLi9pY29ucy9pbmRleC5tanMnYOOAgnRyZWUtc2hha2luZyDlkI7kuqfnianph4zlj6rlianlrp7pmYXnlKjliLDnmoRcbiAqIOWHoOWNgeS4quWbvuagh++8jOS9k+enr+ayoeW3ruWIq++8jOS9huaehOW7uuacn+S7jeimgeino+aekOi/mSA2MDAwIOWkmuS4quaooeWdl++8muWunua1iyByZW5kZXJlciDmrrUgMTA4NzAg4oaSXG4gKiA0NzQ5IOS4quaooeWdl+OAgeW/qyAxLjV+MnPjgILnlKggdHJhbnNmb3JtIOaUueWGmeiAjOS4jeaYr+e7tOaKpOS4gOS7veWbvuagh+a4heWNle+8jOa6kOeggeWGmeazleS/neaMgeS4jeWPmO+8jFxuICog5paw5aKe5Zu+5qCH5pe25Lmf5LiN6ZyA6KaB5ZCM5q2l5Lu75L2V5Lic6KW/44CCXG4gKlxuICog5Y+q5a+5IGJ1aWxkIOeUn+aViO+8mmRldiDkuIvmlLnlhpnkvJrorqnmr4/kuKrlm77moIflkITmiJDkuIDkuKogb3B0aW1pemVEZXBzIOmihOaehOW7uuS6p+eJqe+8iOWunua1iyAxMDAg5LiqXG4gKiBkZXBzIOaWh+S7tu+8ie+8jOWGt+WQr+WKqOWPjeiAjOabtOaFou+8m2RldiDkuqTnu5kgVml0ZSDmiormlbTkuKogYmFycmVsIOmihOaehOW7uuaIkOS4gOS7veWNs+WPr+OAglxuICovXG5mdW5jdGlvbiB0YWJsZXJJY29uRGVlcEltcG9ydHMoKSB7XG4gIGNvbnN0IHNwZWNpZmllciA9ICdAdGFibGVyL2ljb25zLXJlYWN0J1xuICBjb25zdCBkZWVwID0gYCR7c3BlY2lmaWVyfS9kaXN0L2VzbS9pY29uc2BcbiAgcmV0dXJuIHtcbiAgICBuYW1lOiAnbWljYTp0YWJsZXItaWNvbi1kZWVwLWltcG9ydHMnLFxuICAgIGFwcGx5OiAnYnVpbGQnLFxuICAgIGVuZm9yY2U6ICdwcmUnLFxuICAgIHRyYW5zZm9ybShjb2RlLCBpZCkge1xuICAgICAgaWYgKGlkLmluY2x1ZGVzKCcvbm9kZV9tb2R1bGVzLycpIHx8ICFjb2RlLmluY2x1ZGVzKHNwZWNpZmllcikpIHJldHVybiBudWxsXG4gICAgICBjb25zdCBuYW1lZEltcG9ydCA9IC9pbXBvcnRcXHMqXFx7KFtefV0qKVxcfVxccypmcm9tXFxzKihbJ1wiXSlAdGFibGVyXFwvaWNvbnMtcmVhY3RcXDJcXHMqOz8vZ1xuICAgICAgaWYgKCFuYW1lZEltcG9ydC50ZXN0KGNvZGUpKSByZXR1cm4gbnVsbFxuICAgICAgcmV0dXJuIGNvZGUucmVwbGFjZShuYW1lZEltcG9ydCwgKF9tYXRjaCwgbmFtZXMpID0+IHtcbiAgICAgICAgY29uc3QgbGluZXMgPSBuYW1lc1xuICAgICAgICAgIC5zcGxpdCgnLCcpXG4gICAgICAgICAgLm1hcCgoZW50cnkpID0+IGVudHJ5LnRyaW0oKSlcbiAgICAgICAgICAuZmlsdGVyKEJvb2xlYW4pXG4gICAgICAgICAgLm1hcCgoZW50cnkpID0+IHtcbiAgICAgICAgICAgIC8vIOWbvuagh+aooeWdlyBkZWZhdWx0IOWvvOWHuue7hOS7tu+8jOaJgOS7pSBgSWNvblggYXMgQWxpYXNgIOebtOaOpeWPmOaIkCBgaW1wb3J0IEFsaWFzIGZyb20gLi4uYFxuICAgICAgICAgICAgY29uc3QgW2V4cG9ydGVkLCBsb2NhbF0gPSBlbnRyeS5zcGxpdCgvXFxzK2FzXFxzKy8pLm1hcCgodmFsdWUpID0+IHZhbHVlLnRyaW0oKSlcbiAgICAgICAgICAgIHJldHVybiBgaW1wb3J0ICR7bG9jYWwgfHwgZXhwb3J0ZWR9IGZyb20gJyR7ZGVlcH0vJHtleHBvcnRlZH0ubWpzJ2BcbiAgICAgICAgICB9KVxuICAgICAgICAvLyDmraPliJnph4znmoQgYFxccypgIOS8muaKiue7k+WwvuaNouihjOS4gOi1t+WQg+aOie+8jOihpeWbnuadpemBv+WFjeWSjOS4i+S4gOadoeivreWPpeeymOi/nlxuICAgICAgICByZXR1cm4gYCR7bGluZXMuam9pbignXFxuJyl9XFxuYFxuICAgICAgfSlcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgbWFpbjoge1xuICAgIHBsdWdpbnM6IFtleHRlcm5hbGl6ZURlcHNQbHVnaW4oKV0sXG4gICAgcmVzb2x2ZToge1xuICAgICAgYWxpYXM6IHtcbiAgICAgICAgLy8g5YWx5Lqr5YyF5LiO6aG16Z2i5ZCM5LiA5aWX5Yir5ZCN77ya5Li76L+b56iL5Lmf6KaB6K+75Zyw5Z2A57qm5a6a77yIYXBwLXBhdGhzLnRz77yJ77yM5LiN6IO95ZCE5YaZ5LiA5Lu9XG4gICAgICAgICdAcGFja2FnZXMnOiByZXNvbHZlKCcuLi8uLi9wYWNrYWdlcycpLFxuICAgICAgICAvLyDnu4jnq6/nqpflj6PopoHliqDovb3nmoTpobXpnaLot6/lvoTkuI7ov5DooYzml7bot6/nlLHlkIzmupDvvJrnm7TmjqXnlKjlhbHkuqvljIXph4znmoTluLjph4/vvIxcbiAgICAgICAgLy8g5LiN5YaN5Zyo5Li76L+b56iL6YeM5oqE5LiA5Lu9ICcvdGVybWluYWwtY29udHJvbCdcbiAgICAgICAgJ0BtaWNhLWFwcC1wYXRocyc6IHJlc29sdmUoJy4uLy4uL3BhY2thZ2VzL21pY2Etd2ViLXNoYXJlZC9hcHAtcGF0aHMudHMnKVxuICAgICAgfVxuICAgIH1cbiAgfSxcbiAgcHJlbG9hZDoge1xuICAgIGJ1aWxkOiB7XG4gICAgICByb2xsZG93bk9wdGlvbnM6IHtcbiAgICAgICAgaW5wdXQ6IHJlc29sdmUoJ3NyYy9wcmVsb2FkL2luZGV4LmpzJyksXG4gICAgICAgIG91dHB1dDogeyBmb3JtYXQ6ICdjanMnLCBlbnRyeUZpbGVOYW1lczogJ2luZGV4LmpzJyB9XG4gICAgICB9XG4gICAgfVxuICB9LFxuICByZW5kZXJlcjoge1xuICAgIHBsdWdpbnM6IFt0YWJsZXJJY29uRGVlcEltcG9ydHMoKSwgZmlsZUljb25Bc3NldHMoKSwgcGx1Z2luV2ViQXNzZXRzKCksIGVkaXRvcldlYkFzc2V0cygpLCByZWFjdCgpLCB0YWlsd2luZGNzcygpXSxcbiAgICByZXNvbHZlOiB7XG4gICAgICAvLyBwYWNrYWdlcy9taWNhLWNvbmZpZy11aSDnmoTmupDnoIHku47ku5PlupPmoLkgbm9kZV9tb2R1bGVzIOino+aekCByZWFjdO+8jOmhtemdouiEmuacrOWImeS7jlxuICAgICAgLy8gYXBwcy9kZXNrdG9wL25vZGVfbW9kdWxlcyDop6PmnpDvvIzkuKTku73niannkIbot6/lvoTkuI3lkIznmoQgcmVhY3Qg5Lya6KKr5b2T5oiQ5Lik5Liq5a6e5L6L5omT6L+b5YyF77yaXG4gICAgICAvLyDphY3nva7pobXph4zosIPnlKggaG9va3Mg5pe25ou/5Yiw55qE5ZG95ZCN56m66Ze05pivIG51bGzvvIhDYW5ub3QgcmVhZCBwcm9wZXJ0aWVzIG9mIG51bGxcbiAgICAgIC8vIChyZWFkaW5nICd1c2VTdGF0ZScp77yJ44CCZGVkdXBlIOW8uuWItuaUtuaVm+WIsOWQjOS4gOS7veOAglxuICAgICAgZGVkdXBlOiBbJ3JlYWN0JywgJ3JlYWN0LWRvbSddLFxuICAgICAgYWxpYXM6IHtcbiAgICAgICAgJ0ByZW5kZXJlcic6IHJlc29sdmUoJ3NyYy9yZW5kZXJlci9zcmMnKSxcbiAgICAgICAgJ0BwYWNrYWdlcyc6IHJlc29sdmUoJy4uLy4uL3BhY2thZ2VzJyksXG4gICAgICAgIC8vIOaPkuS7tuiHquW3seeahOahjOmdouWFpeWPo++8iGBwbHVnaW5zLzxpZD4vZGVza3RvcC5qc3hg77yJ77ya6aG16Z2i5oyJIGlkIOWOu+aPkuS7tuebruW9leaJvuaooeWdl++8jFxuICAgICAgICAvLyDlrr/kuLvlm6DmraTkuI3pnIDopoHnmbvorrDku7vkvZXlhbfkvZPmj5Lku7bjgILmjIflkJHku5PlupPmoLnvvIxnbG9iIOaJjeiDveaUtuW9lei/meS6m+aWh+S7tuOAglxuICAgICAgICAnQHBsdWdpbnMnOiByZXNvbHZlKCcuLi8uLi9wbHVnaW5zJyksXG4gICAgICAgIC8vIOmFjee9rumhtee7hOS7tuadpeiHqiBwYWNrYWdlcy9taWNhLWNvbmZpZy11ae+8muaYvuW8j+aMh+WQkSAudHN4IOWFpeWPo++8jOmhtemdouS7o+eggeaYryAuanN477yMXG4gICAgICAgIC8vIOWGmSBgLi4uL2luZGV4LmpzYCDkuI3kvJrlm57pgIDliLAgVHlwZVNjcmlwdCDmupDnoIFcbiAgICAgICAgJ0BtaWNhLWNvbmZpZy11aS93ZWInOiByZXNvbHZlKCcuLi8uLi9wYWNrYWdlcy9taWNhLWNvbmZpZy11aS93ZWIvaW5kZXgudHN4JyksXG4gICAgICAgIC8vIOaPkuS7tuWFpeWPo+ihjOeahOWbvuagh+imgeWcqOS+p+agj+mmluWxj+WwseeUu+WHuuadpe+8jOiAjOaVtOS4qumFjee9rumhteaYr+aHkuWKoOi9veeahOeLrOeriyBjaHVua++8mlxuICAgICAgICAvLyDmt7Hot6/lvoTnm7TmjqXmjIflkJHlm77moIfooajvvIzliKvkuLrkuobkuIDkuKrlm77moIfmiorphY3nva7pobXmi5bov5vkuLvljIVcbiAgICAgICAgJ0BtaWNhLWNvbmZpZy11aS9wbHVnaW4taWNvbnMnOiByZXNvbHZlKCcuLi8uLi9wYWNrYWdlcy9taWNhLWNvbmZpZy11aS93ZWIvcGx1Z2luSWNvbnMudHN4JylcbiAgICAgIH1cbiAgICB9LFxuICAgIHNlcnZlcjoge1xuICAgICAgcHJveHk6IHtcbiAgICAgICAgJy9hcGknOiB7IHRhcmdldDogYGh0dHA6Ly8xMjcuMC4wLjE6JHtydW50aW1lUG9ydH1gLCBjaGFuZ2VPcmlnaW46IGZhbHNlIH0sXG4gICAgICAgIC8vIGRldiDkuIvnmoTnu4jnq6/nqpflj6PpobXpnaLvvIgvdGVybWluYWwuaHRtbO+8ieS5n+S7jiBWaXRlIOWKoOi9ve+8jOWug+iuv+mXrueahFxuICAgICAgICAvLyAvcmVtb3RlL3Rlcm1pbmFsLyog5b+F6aG76JC95Yiw6L+Q6KGM5pe277yM5YaN55Sx6L+Q6KGM5pe25Luj55CG5Yiw5Li76L+b56iLXG4gICAgICAgICcvcmVtb3RlJzogeyB0YXJnZXQ6IGBodHRwOi8vMTI3LjAuMC4xOiR7cnVudGltZVBvcnR9YCwgY2hhbmdlT3JpZ2luOiBmYWxzZSB9XG4gICAgICB9XG4gICAgfSxcbiAgICBidWlsZDoge1xuICAgICAgLy8g5Lik5Liq5a6/5Li76aG16Z2i5YWl5Y+j77ya5Li75bqU55So5LiO57uI56uv5o6n5Yi256qX5Y+j77yI6L+Q6KGM5pe25oyJIC90ZXJtaW5hbC1jb250cm9sIOaPkOS+m++8ieOAglxuICAgICAgLy8g5paH5Lu257yW6L6R5Zmo5LuN5piv5Li75bqU55So6KeG5Zu+77yb5YWx5LqrIExleGljYWwg6ZqU56a76aG16Z2i55SxIGVkaXRvcldlYkFzc2V0cyDljZXni6zmnoTlu7rjgIJcbiAgICAgIHJvbGx1cE9wdGlvbnM6IHtcbiAgICAgICAgaW5wdXQ6IHtcbiAgICAgICAgICBpbmRleDogcmVzb2x2ZSgnc3JjL3JlbmRlcmVyL2luZGV4Lmh0bWwnKSxcbiAgICAgICAgICB0ZXJtaW5hbDogcmVzb2x2ZSgnc3JjL3JlbmRlcmVyL3Rlcm1pbmFsLmh0bWwnKVxuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgLy8gZWxlY3Ryb24tdml0ZSDnmoQgcmVuZGVyZXIg6buY6K6kIGJ1aWxkLm1pbmlmeSA9IGZhbHNl77yI5a6D5Y+q5a+5IG1haW4vcHJlbG9hZFxuICAgICAgLy8g5pyJ5ZCI55CG55CG55Sx77yJ77yM5LiN6KaG55uW5Lya6K6p6aG16Z2i6KOF6L295LiA5Lu95Y2B5YegIE1CIOacquWOi+e8qeeahCBidW5kbGXjgIJcbiAgICAgIG1pbmlmeTogdHJ1ZSxcbiAgICAgIC8vIOavj+asoeaehOW7uumDveimgeS4uuavj+S4qiBjaHVuayDot5HkuIDpgY0gZ3ppcCDmiY3nrpfkvZPnp6/vvIxtb25hY28g5Y2V5Z2XIDMuNk1C77yMXG4gICAgICAvLyDov5npg6jliIbnuq/nu5/orqHlvIDplIDlnKjmnKzlnLDlj43lpI3mnoTlu7rml7blvojmmL7nnLzvvIzkvZPnp6/lkYrorabnlLEgY2h1bmtTaXplV2FybmluZ0xpbWl0IOWFnOW6leOAglxuICAgICAgcmVwb3J0Q29tcHJlc3NlZFNpemU6IGZhbHNlLFxuICAgICAgLy8g5ouG5YyF5ZCO5Y2V5LiqIGNodW5rIOS8muaYjuaYvuWPmOWkp++8iG1vbmFjbyDni6znq4vmiJDlnZfvvInvvIzpmIjlgLzot5/nnYDmlL7lrr3vvIxcbiAgICAgIC8vIOWQpuWImeavj+asoeaehOW7uumDveWIt+S4gOadoeivr+WvvOaAp+eahOWRiuitpuOAglxuICAgICAgY2h1bmtTaXplV2FybmluZ0xpbWl0OiAyMDQ4XG4gICAgfVxuICB9XG59KVxuIl0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7O0FBb0JBLE1BQWEsdUJBQXVCOztBQUdwQyxNQUFhLG1CQUFtQjs7QUFTaEMsTUFBYSx3QkFBd0I7Ozs7Ozs7Ozs7O0FBWXJDLFNBQWdCLGlCQUFpQixPQUFPLFdBQVcsc0JBQXNCO0NBR3ZFLE1BQU0sT0FBTyxPQUFPLFVBQVUsV0FBVyxPQUFPLE9BQU8sU0FBUyxFQUFFLENBQUMsQ0FBQyxLQUFLO0NBQ3pFLE1BQU0sU0FBUyxTQUFTLE9BQU8sUUFBUSxR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