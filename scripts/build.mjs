import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
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

function buildBinary(file, appName) {
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
      '--define',
      `__MICA_APP_NAME__=${JSON.stringify(appName)}`,
      './apps/cli/src/index.ts',
      '--outfile',
      file,
    ],
    {
      stdio: 'inherit',
    },
  );
  console.log(`Built native binary: ${file} (app name: ${appName})`);
}

buildBinary(outFile, outName);

// 额外别名二进制（如 studio）：与主二进制共用同一份源码，仅注入不同的
// __MICA_APP_NAME__，让命令名 / 终端标题 / 版本输出保持独立，不修改原命令。
// 用 MICA_BUILD_ALIASES= 清空可关闭；别名输出到主输出同目录。
const aliases = (process.env.MICA_BUILD_ALIASES ?? 'studio')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
for (const alias of aliases) {
  buildBinary(join(targetDir, alias), alias);
}
