import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 把 `plugins/mobile-relay/agent/bridge.mjs` 内嵌成 `bridgeSource.ts`。
 *
 * 随包插件跑在单二进制里，插件目录不是可执行目录，所以桥脚本必须先落盘再交给 node。
 * 与 `packages/mica-pty` 的 `server.mjs` / computer-use 的 runtime 是同一套做法：
 * `.mjs` 保持可读可跑，读的内容由本脚本生成，避免两份实现漂移。
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const sourcePath = join(root, 'plugins', 'mobile-relay', 'agent', 'bridge.mjs');
const outPath = join(root, 'plugins', 'mobile-relay', 'bridgeSource.ts');

const source = readFileSync(sourcePath, 'utf8');
const banner = [
  '// AUTO-GENERATED from plugins/mobile-relay/agent/bridge.mjs. Do not edit by hand;',
  '// run `bun scripts/generate-mobile-relay-sources.mjs` after editing the source.',
  '',
].join('\n');

writeFileSync(outPath, `${banner}export const BRIDGE_SOURCE = ${JSON.stringify(source)};\n`, 'utf8');
console.log(`已生成 ${outPath}（${source.length} 字符）`);
