// Regenerates packages/mica-pty/src/ptyServerSource.ts from the Node-side PTY
// server source (packages/mica-pty/src/server.mjs), which is the single source
// of truth. The generated TS module embeds the server code as a plain string so
// it survives bun build --compile (the bundler does not support ?raw imports).
//
// Run after editing server.mjs:
//   bun run scripts/generate-pty-server-source.mjs
// packages/mica-pty/tests/serverSource.test.ts asserts the two stay in sync.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const serverFile = fileURLToPath(new URL('../packages/mica-pty/src/server.mjs', import.meta.url));
const outFile = fileURLToPath(new URL('../packages/mica-pty/src/ptyServerSource.ts', import.meta.url));

const src = readFileSync(serverFile, 'utf8');
if (src.includes('`') || src.includes('${')) {
  throw new Error('server.mjs must stay free of backticks and ${...} so it can be embedded in a template literal');
}

const header = [
  '// AUTO-GENERATED from packages/mica-pty/src/server.mjs. Do not edit by hand;',
  '// run "bun run scripts/generate-pty-server-source.mjs" after changing the server.',
  '//',
  '// Embeds the Node-side PTY server source as a JSON-escaped string so the Bun',
  '// host can materialize it at runtime (dev, headless, and the compiled single',
  '// binary). The server runs under node, never inside Bun.',
  '',
  // Prettier formats over-length string literals as `= <newline>  "..."`.
  `export const ptyServerSource: string =\n  ${JSON.stringify(src)};`,
].join('\n');

writeFileSync(outFile, `${header}\n`, 'utf-8');
console.log(`Wrote ${outFile} (${src.length} chars)`);
