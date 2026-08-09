// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  site: 'https://qirong77.github.io/',
  // GitHub Pages 构建时由 actions/configure-pages 注入 PAGES_BASE_PATH（如 /mica-code/）；
  // 本地 dev / preview 不设置该变量，base 为 /，路径不带前缀。
  base: process.env.PAGES_BASE_PATH || '/',
  output: 'static',
});
