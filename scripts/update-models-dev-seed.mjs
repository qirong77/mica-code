// Refresh the bundled models.dev seed used as an offline fallback for model
// rule resolution. The seed is stored gzip -> base64 inside a generated TS
// module so it survives `bun build --compile` while staying ~10x smaller than
// the raw JSON (the bundler does not support ?raw imports).
//
// Run manually or from CI; a failure exits non-zero so release workflows can
// decide whether to block (the committed seed stays as the fallback):
//   bun run scripts/update-models-dev-seed.mjs
import { gzipSync } from 'node:zlib';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MODELS_URL = 'https://models.dev/api.json';
const SEED_OUT_PATH = new URL('../plugins/builtin/model-effort-context/seed/models-dev.seed.ts', import.meta.url);
const FETCH_TIMEOUT_MS = 30_000;
const CACHE_VERSION = 1;

async function main() {
  console.log(`Refreshing models.dev seed from ${MODELS_URL}...`);
  const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`models.dev request failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json();
  if (!isModelsPayload(payload)) {
    throw new Error('models.dev returned an invalid payload; seed left unchanged');
  }

  const entry = { version: CACHE_VERSION, fetchedAt: Date.now(), payload };
  const compressed = gzipSync(Buffer.from(`${JSON.stringify(entry)}\n`, 'utf8')).toString('base64');
  const moduleSource = [
    '// AUTO-GENERATED from https://models.dev/api.json by scripts/update-models-dev-seed.mjs.',
    '// Do not edit by hand; run "bun run scripts/update-models-dev-seed.mjs" to refresh.',
    '//',
    '// Embeds the models.dev snapshot as gzip -> base64 so it survives bun build',
    '// --compile and stays ~10x smaller than the raw JSON. Decode with',
    '// gunzipSync(Buffer.from(modelsDevSeedBase64, "base64")).',
    '',
    // Single quotes keep the generated module Prettier-stable: base64 never
    // contains a single quote, and Prettier prefers the shorter quoting.
    `export const modelsDevSeedBase64: string =\n  '${compressed}';`,
  ].join('\n');

  const temporaryPath = `${SEED_OUT_PATH.pathname}.${process.pid}.tmp`;
  await mkdir(dirname(SEED_OUT_PATH.pathname), { recursive: true });
  await writeFile(temporaryPath, `${moduleSource}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryPath, SEED_OUT_PATH.pathname);
  await rm(temporaryPath, { force: true }).catch(() => undefined);

  console.log(
    `Seed updated: ${SEED_OUT_PATH.pathname} (${compressed.length} base64 chars, fetchedAt=${entry.fetchedAt})`,
  );
}

function isModelsPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.values(value).some(
    (provider) => provider && typeof provider === 'object' && provider.models && typeof provider.models === 'object',
  );
}

main().catch((error) => {
  console.error(`models.dev seed refresh failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
