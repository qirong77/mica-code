#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const extra = process.argv.slice(2);

function runVitest(args) {
  const result = spawnSync(process.execPath, [vitest, 'run', ...args], { stdio: 'inherit', cwd: root });
  return result.status ?? 1;
}

// 显式给了文件或过滤参数时直接单次运行，vitest 会按 project 的 include 归位。
if (extra.length > 0) process.exit(runVitest(extra));

// 两个 project 串行：process project 里是真实子进程、PTY 与 TUI，和 unit 的
// worker 抢 CPU 时，对时序敏感的用例（btw.pty、turn lease）会偶发失败。
// unit 先跑，它失败时就不再花时间启动进程级 E2E。
let code = runVitest(['--project', 'unit']);
if (code === 0) code = runVitest(['--project', 'process']);
process.exit(code);
