import { describe, expect, it, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPluginAction } from './pluginAction';

/**
 * 用一个假 CLI 冒充 `mica plugin-action`：这里要验的是配置页宿主怎么读那行 JSON，
 * 插件进程本身在 apps/cli 那边有自己的测试。
 */
const dirs: string[] = [];

function fakeCli(json: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-action-'));
  dirs.push(dir);
  const file = join(dir, 'mica');
  writeFileSync(file, `#!/bin/sh\ncat <<'EOF'\n${json}\nEOF\n`, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('config page plugin actions', () => {
  it('把「交给新会话」的交接单原样带回页面', async () => {
    const cliPath = fakeCli(JSON.stringify({ ok: true, newSession: { prompt: '去更新页面', send: false } }));
    const result = await runPluginAction({ id: 'mobile-relay', action: 'sync-page' }, { cliPath });
    // 没有一句话可显示也要算是成功：这类动作的产出就是那段提示词。
    expect(result.message).toBe('');
    expect(result.newSession).toEqual({ prompt: '去更新页面', send: false });
  });

  it('既没有话也没有交接单时仍然算失败，不安静地当成功', async () => {
    const cliPath = fakeCli(JSON.stringify({ ok: true }));
    await expect(runPluginAction({ id: 'mobile-relay', action: 'sync-page' }, { cliPath })).rejects.toThrow();
  });

  it('插件报错就走拒绝，而不是安静地什么都不做', async () => {
    const cliPath = fakeCli(JSON.stringify({ ok: false, error: '还没连接中转机' }));
    await expect(runPluginAction({ id: 'mobile-relay', action: 'register' }, { cliPath })).rejects.toThrow(
      '还没连接中转机',
    );
  });
});
