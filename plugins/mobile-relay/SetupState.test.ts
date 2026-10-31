import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

describe('setup machine list', () => {
  it('keeps the enrollment policy and existing identity when preparing a repeat deployment', () => {
    const source = readFileSync(new URL('./setup.mjs', import.meta.url), 'utf8');
    // 只运行部署之前的清单准备；SSH 读取也用替身，不执行部署或真实注册。
    const preparation = source
      .slice(0, source.indexOf("if (!joinMode) {\nstep('打包并上传"))
      .replace(/^import .*\n/gm, '')
      .replace('import.meta.dirname', JSON.stringify('/isolated/mobile-relay'));
    const existing = {
      version: 1,
      enrollKey: 'keep-enrollment-secret',
      agents: [{ id: 'old', label: 'Test Mac', token: 'a'.repeat(48), identityHash: 'b'.repeat(64), createdAt: 123 }],
    };
    const execFileSync = vi.fn(() => JSON.stringify(existing));
    const context = {
      process: {
        argv: ['node', 'setup.mjs', '--dry-run', '--host', 'root@relay.test', '--domain', 'relay.test'],
        env: { MICA_HOME: '/isolated' },
        stdout: { write: vi.fn() },
        exit: () => {
          throw new Error('unexpected exit');
        },
      },
      execFileSync,
      readFileSync: () => '{}',
      hostname: () => 'Test Mac',
      join,
      createHash,
      randomBytes,
      console,
      payload: {} as typeof existing,
    };
    runInNewContext(`${preparation}\nglobalThis.payload = agentsPayload;`, context);
    expect(context.payload.enrollKey).toBe(existing.enrollKey);
    expect(context.payload.agents).toHaveLength(1);
    expect(context.payload.agents[0]).toMatchObject({
      token: 'a'.repeat(48),
      identityHash: 'b'.repeat(64),
      createdAt: 123,
    });
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });
});
