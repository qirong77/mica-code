import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// codegraph 是独立子目录，有自己的 package.json 和构建流程
const PROJECT_ROOT = resolve(import.meta.dirname, '..');
const CODEGRAPH_DIR = resolve(PROJECT_ROOT, 'codegraph');
const CODEGRAPH_BIN = resolve(CODEGRAPH_DIR, 'dist', 'bin', 'codegraph.js');

function run(cmd: string, cwd?: string) {
  return execSync(cmd, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function step(label: string) {
  process.stdout.write(`  ${label}... `);
}

function ok(msg?: string) {
  console.log(msg ? `ok (${msg})` : 'ok');
}

function fail(msg: string): never {
  console.log(`FAIL`);
  console.error(`  ${msg}`);
  process.exit(1);
}

console.log('prebuild: validating codegraph\n');

// codegraph 依赖 Node >= 21.7（使用 fs.glob 等新 API）
const nodeVersion = process.versions.node;
const major = parseInt(nodeVersion.split('.')[0], 10);
if (major < 21) {
  console.log('  Node version check... WARN');
  console.log(`  Current Node ${nodeVersion} is too old for codegraph (needs >= 21.7).`);
  console.log('  Switch with: nvm use 22');
  console.log('  Skipping codegraph validation.\n');
  process.exit(0);
}

step('check codegraph directory');
if (!existsSync(CODEGRAPH_DIR)) fail(`codegraph directory not found: ${CODEGRAPH_DIR}`);
ok();

step('install codegraph dependencies');
if (!existsSync(resolve(CODEGRAPH_DIR, 'node_modules'))) {
  // --ignore-scripts 跳过 postinstall 等脚本，只安装依赖
  run('npm install --ignore-scripts', CODEGRAPH_DIR);
} else {
  process.stdout.write('skip (already installed) ');
}
ok();

step('build codegraph');
run('npm run build', CODEGRAPH_DIR);
ok();

step('codegraph init');
try {
  const initOut = run(`node ${CODEGRAPH_BIN} init ${PROJECT_ROOT}`, PROJECT_ROOT);
  if (initOut) console.log(`\n    ${initOut.split('\n').join('\n    ')}`);
} catch (e: unknown) {
  const err = e as Error & { stderr?: string };
  const errMsg = err.stderr || err.message;
  fail(`codegraph init failed: ${errMsg}`);
}
ok();

step('codegraph status');
try {
  const status = run(`node ${CODEGRAPH_BIN} status ${PROJECT_ROOT}`, PROJECT_ROOT);
  console.log();
  console.log(status.split('\n').map((l) => `    ${l}`).join('\n'));
} catch (e: unknown) {
  const err = e as Error & { stderr?: string };
  const errMsg = err.stderr || err.message;
  fail(`codegraph status failed: ${errMsg}`);
}

console.log('\nprebuild: codegraph validated successfully');
