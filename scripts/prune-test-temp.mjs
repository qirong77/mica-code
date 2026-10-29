#!/usr/bin/env node
// 测试 helper 各自在 os.tmpdir() 里建目录，被强杀或超时的运行不会留下清理机会。
// 这里按 mtime 清掉过期的那一批，避免几轮下来累积成几个 G。
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
