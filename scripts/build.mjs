import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

if (process.env.MICA_PREBUILD_DONE === '1') {
  console.log('Prebuild checks completed.\n');
} else {
  console.log('Running prebuild checks...\n');
  execSync('bun run prebuild', { stdio: 'inherit' });
}

const buildTime = new Date().toISOString();
console.log(`Build time: ${buildTime}`);

const outDir = process.env.MICA_BUILD_DIR ?? 'dist';
const outName = process.env.MICA_BUILD_NAME ?? 'mica';
const outFile = process.env.MICA_BUILD_OUTFILE ?? join(outDir, outName);
const target = process.env.MICA_BUILD_TARGET;

const targetDir = dirname(outFile);
if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

console.log('Building config web assets...\n');
execSync('bun run build:config-web', { stdio: 'inherit' });

execFileSync('bun', [
  'build',
  '--compile',
  ...(target ? ['--target', target] : []),
  '--define',
  `__MICA_BUILD_TIME__=${JSON.stringify(buildTime)}`,
  './src/index.ts',
  '--outfile',
  outFile,
], {
  stdio: 'inherit',
});
console.log(`Built native binary: ${outFile}`);
