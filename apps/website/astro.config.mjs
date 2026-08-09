// @ts-check
import { defineConfig } from 'astro/config';

// GitHub Pages 构建时由 workflow 把 configure-pages 的 base_path output 注入
// PAGES_BASE_PATH（如 /mica-code）；本地 dev / preview 不设置该变量，base 为 /。
// 注意：base_path output 不带尾斜杠，而模板用 `${base}mica.svg` 直接拼接，
// 必须归一化出尾斜杠，否则会生成 /mica-codemica.svg 这类错位路径。
const rawBase = process.env.PAGES_BASE_PATH || '';
const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;

// https://astro.build/config
export default defineConfig({
  site: 'https://qirong77.github.io/',
  base,
  output: 'static',
});
