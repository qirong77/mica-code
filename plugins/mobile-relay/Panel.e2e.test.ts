import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import { createPanelHandler } from './Panel.js';

/**
 * 一次性手工验证（默认跳过）：走真实的 SSH + 中转机，确认面板按钮真的能登记机器。
 * 跑法：MICA_E2E_RELAY=root@155.254.127.215 MICA_E2E_PORT=2222 bun run test -- plugins/mobile-relay/Panel.e2e
 */
describe.skipIf(!process.env.MICA_E2E_RELAY)('panel apply against a real relay', () => {
  it('registers this machine through the panel action', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-panel-e2e-'));
    const ctx = {
      pluginId: 'mobile-relay',
      settings: { path: null, get: () => ({ enabled: 'true', relayUrl: '', token: '' }), validate: () => [] },
      health: { report: vi.fn() },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext;

    const handler = createPanelHandler(ctx, dir);
    const result = await handler.action({
      action: 'apply',
      values: {
        sshHost: String(process.env.MICA_E2E_RELAY),
        sshPort: String(process.env.MICA_E2E_PORT || '22'),
        label: '面板端到端测试',
      },
    });
    expect(result).toMatchObject({ message: expect.stringContaining('完成') });
  }, 300_000);
});
