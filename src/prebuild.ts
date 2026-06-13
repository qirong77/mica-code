import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

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
  console.log('FAIL');
  console.error(`  ${msg}`);
  process.exit(1);
}

console.log('prebuild: validating codegraph\n');

step('check codegraph CLI');
let codegraphInstalled = false;
try {
  const which = run('which codegraph');
  if (which) {
    codegraphInstalled = true;
    ok(which);
  }
} catch {
  codegraphInstalled = false;
}

if (!codegraphInstalled) {
  step('install codegraph');
  try {
    run('curl -fsSL https://raw.githubusercontent.com/colbymchenry/codegraph/main/install.sh | sh');
    ok();
  } catch (e: unknown) {
    const err = e as Error & { stderr?: string };
    fail(`codegraph install failed: ${err.stderr || err.message}`);
  }
}

step('codegraph init');
try {
  const initOut = run(`codegraph init ${PROJECT_ROOT}`, PROJECT_ROOT);
  if (initOut) console.log(`\n    ${initOut.split('\n').join('\n    ')}`);
} catch (e: unknown) {
  const err = e as Error & { stderr?: string };
  fail(`codegraph init failed: ${err.stderr || err.message}`);
}
ok();

step('codegraph status');
try {
  const status = run(`codegraph status ${PROJECT_ROOT}`, PROJECT_ROOT);
  console.log();
  console.log(status.split('\n').map((l) => `    ${l}`).join('\n'));
} catch (e: unknown) {
  const err = e as Error & { stderr?: string };
  fail(`codegraph status failed: ${err.stderr || err.message}`);
}

console.log('\nprebuild: codegraph validated successfully');
