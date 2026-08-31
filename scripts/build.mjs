import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

if (process.env.MICA_PREBUILD_DONE === '1') {
  console.log('Prebuild checks completed.\n');
} else {
  console.log('Running prebuild checks...\n');
  execSync('bun run prebuild', { stdio: 'inherit' });
}

const buildTime = new Date().toISOString();
let buildVersion = process.env.MICA_VERSION?.trim() || 'dev';
if (buildVersion === 'dev') {
  try {
    buildVersion = execFileSync('git', ['describe', '--tags', '--always', '--dirty'], { encoding: 'utf8' }).trim();
  } catch {
    // Source archives and release builders may not include git metadata.
  }
}
if (!/^v?\d+\.\d+\.\d+/.test(buildVersion)) {
  buildVersion = `0.1.0+${buildVersion}`;
}
console.log(`Build time: ${buildTime}`);
console.log(`Build version: ${buildVersion}`);

// Read build-time runtime branding from mica.build.env (source-controlled).
// Each key may also be overridden by the matching MICA_* env var at build time.
const buildEnv = readBuildEnv();
const defineBrand = (name, envName, fallback) => {
  const value = process.env[envName] || buildEnv[envName] || fallback;
  console.log(`Build branding: ${envName}=${value}`);
  return ['--define', `${name}=${JSON.stringify(value)}`];
};

const outDir = process.env.MICA_BUILD_DIR ?? 'dist';
const outName = process.env.MICA_BUILD_NAME ?? 'mica';
const outFile = process.env.MICA_BUILD_OUTFILE ?? join(outDir, outName);
const target = process.env.MICA_BUILD_TARGET;

const targetDir = dirname(outFile);
if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
const legacySharpRuntimeDir = join(targetDir, 'sharp-runtime');
if (existsSync(legacySharpRuntimeDir)) rmSync(legacySharpRuntimeDir, { recursive: true, force: true });

console.log('Building config web assets...\n');
execSync('bun run build:config-web', { stdio: 'inherit' });

execFileSync(
  'bun',
  [
    'build',
    '--compile',
    '--compile-autoload-package-json',
    ...(target ? ['--target', target] : []),
    '--define',
    `__MICA_BUILD_TIME__=${JSON.stringify(buildTime)}`,
    '--define',
    `__MICA_VERSION__=${JSON.stringify(buildVersion)}`,
    ...defineBrand('__MICA_RUNTIME_NAME__', 'MICA_RUNTIME_NAME', 'mica'),
    ...defineBrand('__MICA_VERSION_LABEL__', 'MICA_VERSION_LABEL', 'mica-code'),
    ...defineBrand('__MICA_APP_NAME__', 'MICA_APP_NAME', 'Mica Code'),
    ...defineBrand('__MICA_CONFIG_DIR_NAME__', 'MICA_CONFIG_DIR_NAME', '.mica'),
    './apps/cli/src/index.ts',
    '--outfile',
    outFile,
  ],
  {
    stdio: 'inherit',
  },
);
console.log(`Built native binary: ${outFile}`);

function readBuildEnv() {
  const envFile = join(import.meta.dirname, '..', 'mica.build.env');
  const result = {};
  try {
    for (const rawLine of readFileSync(envFile, 'utf-8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  } catch {
    // No mica.build.env: use the defaults supplied by defineBrand.
  }
  return result;
}
