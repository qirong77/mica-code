// @ts-check
import { defineConfig } from 'astro/config';

// GitHub Pages 构建时由 workflow 把 configure-pages 的 base_path output 注入
// PAGES_BASE_PATH（如 /mica-code）；本地 dev / preview 不设置该变量，base 为 /。
// 注意：base_path output 不带尾斜杠，而模板用 `${base}docs/getting-started` 这类
// 拼接，必须归一化出尾斜杠，否则会生成 /mica-codedocs/... 这样的错位路径。
// （品牌标志经 Vite 资源导入，base 前缀由构建自动补，不走这里的拼接。）
const rawBase = process.env.PAGES_BASE_PATH || '';
const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;

// https://astro.build/config
export default defineConfig({
  site: 'https://qirong77.github.io/',
  base,
  output: 'static',
});
