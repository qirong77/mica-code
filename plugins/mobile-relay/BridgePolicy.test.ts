import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * 桥的白名单是手机端「能用什么」的唯一事实来源。
 *
 * 这里跑的是真脚本（`agent/bridge.mjs`），只让它在打印策略后立刻退出：白名单写在
 * 源码里，靠正则去扒字符串会在下一次重排时就静默失效。断言的重点不是「有没有某个
 * 字符串」，而是那条边界——常用能力默认放行、写工作区的默认拒绝、依赖桌面外壳的
 * 永远不放行（放行只是让手机端收到一个必然失败的报错）。
 */

const bridgeScript = join(import.meta.dirname, 'agent', 'bridge.mjs');

let home = '';

function readPolicy(): { base: string[]; writes: string[] } {
  const stdout = execFileSync(process.execPath, [bridgeScript], {
    env: {
      ...process.env,
      MICA_HOME: home,
      MICA_RELAY_POLICY: '1',
      RELAY_URL: 'https://relay.example.test',
      RELAY_TOKEN: 'p'.repeat(32),
    },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { base: string[]; writes: string[] };
}

let policy: { base: string[]; writes: string[] };

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'mica-bridge-policy-'));
  policy = readPolicy();
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('桥的白名单', () => {
  it('配置页与插件入口默认可用：手机上改主题、点插件按钮不该被挡', () => {
    expect(policy.base).toEqual(
      expect.arrayContaining([
        'config-web:invoke',
        'chat:plugin-panel-view',
        'chat:plugin-panel-action',
        'chat:session-menu-run',
        'chat:set-plugin-settings',
        'chat:btw-ask',
        'plugin-host:run-action',
      ]),
    );
  });

  it('写工作区的通道单独列出来，默认不在放行集合里', () => {
    expect(policy.writes).toEqual(
      expect.arrayContaining(['files:write', 'files:delete', 'git:discard', 'chat:commit', 'share:add']),
    );
    for (const channel of policy.writes) expect(policy.base).not.toContain(channel);
  });

  it('依赖桌面外壳的通道不放行——放行只会换来一个必然失败的调用', () => {
    for (const channel of policy.base) {
      expect(channel.startsWith('terminal-control:')).toBe(false);
      expect(channel.startsWith('browser-control:')).toBe(false);
    }
  });
});
