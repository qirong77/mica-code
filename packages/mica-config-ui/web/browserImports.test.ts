import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 浏览器侧（`web/`）的 import 不许走那几个会带进 Node 内置模块的包入口。
 *
 * 两个包入口都会顺带导出读写文件的模块，Vite 在 dev 里把它们 externalize 成空对象，
 * 页面直接白屏，而 tsc 与单元测试都看不见——只有真正打开页面才发现。所以这里按
 * 源码静态挡住：需要里面的纯逻辑就深路径取对应的子模块。
 */
const FORBIDDEN = ['@packages/mica-plugin/index.js', '@packages/mica-common/index.js'];
const WEB_DIR = join(import.meta.dirname);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('config web 浏览器侧依赖', () => {
  it('不从带去 Node 内置模块的包入口 import', () => {
    const offenders = sources(WEB_DIR).flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return FORBIDDEN.filter((spec) => text.includes(`'${spec}'`)).map(
        (spec) => `${file.slice(WEB_DIR.length + 1)} → ${spec}`,
      );
    });
    expect(offenders).toEqual([]);
  });
});
