#!/usr/bin/env node
// 测试 helper 各自在 os.tmpdir() 里建目录，被强杀或超时的运行不会留下清理机会。
// 这里按 mtime 清掉过期的那一批，避免几轮下来累积成几个 G。
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const MAX_AGE_MS = Number(process.env.MICA_TEST_TEMP_MAX_AGE_HOURS ?? 6) * 60 * 60 * 1000;
// mica-tasks 是本会话后台任务的输出目录，不属于测试产物。
const KEEP = new Set(['mica-tasks']);

const root = tmpdir();
const cutoff = Date.now() - MAX_AGE_MS;
let removed = 0;

for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith('mica')) continue;
  if (KEEP.has(entry.name)) continue;
  const path = join(root, entry.name);
  try {
    if (statSync(path).mtimeMs > cutoff) continue;
    rmSync(path, { recursive: true, force: true });
    removed += 1;
  } catch {
    // 正在被别的进程使用，跳过即可。
  }
}

if (removed > 0) console.log(`[prune-test-temp] 清理 ${removed} 个过期测试临时目录`);

/**
 * 被强杀的测试运行会把子进程留成孤儿：`bun apps/cli/src/index.ts exec ...` 没有父进程
 * 收尾，会一直占着一个核（实测有进程跑了 4 天）。它们的 MICA_HOME 指向本轮已删掉的
 * 临时目录，所以只认「命令是 mica CLI、MICA_HOME 在 tmpdir 下且目录已不存在」这两条，
 * 正在跑的测试（目录还在）不会被误杀。
 */
function killLeakedTestProcesses() {
  if (process.platform === 'win32') return 0;
  let output;
  try {
    output = execFileSync('ps', ['eww', '-A', '-o', 'pid=,command='], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return 0;
  }
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const cli = /(?:apps\/cli\/src\/index\.ts|dist\/mica)(?:\s|$)/;
  const leaked = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!pid || pid === process.pid) continue;
    if (!cli.test(match[2])) continue;
    const home = /(?:^|\s)MICA_HOME=([^\s]+)/.exec(match[2])?.[1];
    if (!home || !home.startsWith(prefix) || existsSync(home)) continue;
    leaked.push(pid);
  }
  for (const pid of leaked) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // 已经退出
    }
  }
  if (leaked.length) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    for (const pid of leaked) {
      try {
        process.kill(pid, 0);
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已经退出
      }
    }
    console.log(`[prune-test-temp] 结束 ${leaked.length} 个泄漏的测试进程`);
  }
  return leaked.length;
}

killLeakedTestProcesses();
