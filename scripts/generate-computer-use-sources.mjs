// Regenerates plugins/computer-use/runtimeSources.ts from the runtime sources
// (plugins/computer-use/runtime/{scripts/desktop.mjs,src/helper.m}), which are
// the single source of truth. The generated module embeds them as strings so
// they survive `bun build --compile`: official plugins ship inside the single
// binary, so there is no plugin directory on disk to read them from.
//
// Run after editing either file:
//   bun run scripts/generate-computer-use-sources.mjs
// plugins/computer-use/index.test.ts asserts the two stay in sync.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../plugins/computer-use/', import.meta.url);
const outFile = fileURLToPath(new URL('runtimeSources.ts', root));

/** 落盘后的相对路径 → 源文件。顺序即落盘顺序，测试按同一顺序比对。 */
const FILES = [
  { target: 'scripts/desktop.mjs', source: 'runtime/scripts/desktop.mjs' },
  { target: 'src/helper.m', source: 'runtime/src/helper.m' },
];

const entries = FILES.map((file) => ({
  target: file.target,
  content: readFileSync(fileURLToPath(new URL(file.source, root)), 'utf8'),
}));

const body = entries
  .map((entry) => `  ${JSON.stringify(entry.target)}: ${JSON.stringify(entry.content)},`)
  .join('\n');

const header = [
  '// AUTO-GENERATED from plugins/computer-use/runtime/**. Do not edit by hand;',
  '// run "bun run scripts/generate-computer-use-sources.mjs" after changing the runtime.',
  '//',
  '// Embeds the runtime as JSON-escaped strings so the plugin can materialize it into',
  '// $MICA_HOME/computer-use at setup: the compiled binary has no plugin directory to',
  '// copy from, and the skill must point at real files on disk.',
  '',
  '/** 落盘相对路径 → 文件内容。`scripts/desktop.mjs` 依赖 `src/helper.m` 的相对位置。 */',
  'export const COMPUTER_USE_RUNTIME_FILES: Record<string, string> = {',
  body,
  '};',
].join('\n');

writeFileSync(outFile, `${header}\n`, 'utf-8');
const total = entries.reduce((sum, entry) => sum + entry.content.length, 0);
console.log(`Wrote ${outFile} (${entries.length} files, ${total} chars)`);
