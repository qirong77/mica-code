import { build } from 'vite'
import { fileURLToPath } from 'node:url'

/** 独立构建：只编译插件源码，所有第三方运行时由 import map 指向固定版本 CDN。 */
export default async function buildNotebookAssets({ outDir }) {
  await build({
    configFile: fileURLToPath(new URL('./editor/vite.config.mjs', import.meta.url)),
    build: { outDir, emptyOutDir: true }
  })
}
