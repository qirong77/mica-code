import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 每个测试文件在自己的 worker 进程里跑，worker 是被直接杀掉的，setupFiles 里注册的
// exit 钩子不会触发；临时根目录必须由主进程在整轮结束时删除。
export default function setup() {
  const created = !process.env.MICA_TEST_ROOT;
  const root = process.env.MICA_TEST_ROOT || mkdtempSync(join(tmpdir(), 'mica-tests-'));
  process.env.MICA_TEST_ROOT = root;

  return () => {
    if (!created) return;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // 残留目录不影响结果，下次跑测试时会被 prune-test-temp.mjs 扫掉。
    }
  };
}
