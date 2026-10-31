import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentUsageRecord } from '@packages/mica-agent/index.js';
import { parseUsageLedger } from '@packages/mica-web-shared/usage-ledger.js';
import { appendPluginUsage } from './usageLedger.js';

const directories: string[] = [];

function usage(overrides: Partial<AgentUsageRecord> = {}): AgentUsageRecord {
  return {
    usageId: 'u',
    occurredAt: '2026-10-01T10:00:00.000Z',
    turnId: 1,
    requestIndex: 0,
    model: 'deepseek-chat',
    provider: 'deepseek',
    messageCount: 1,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    paidTokenRate: 0,
    ...overrides,
  };
}

function ledgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mica-usage-ledger-'));
  directories.push(dir);
  return join(dir, 'usage-ledger.jsonl');
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('appendPluginUsage', () => {
  it('appends one line per request and keeps the plugin attribution', () => {
    const path = ledgerPath();
    const written = appendPluginUsage({
      pluginId: 'commit',
      purpose: '写提交说明',
      cwd: '/repo',
      path,
      requests: [
        usage({
          usageId: 'u1',
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 10,
          totalTokens: 110,
        }),
        usage({
          usageId: 'u2',
          occurredAt: '2026-10-01T10:00:05.000Z',
          inputTokens: 20,
          outputTokens: 4,
          totalTokens: 24,
        }),
      ],
    });

    expect(written).toBe(2);
    // 写进去的东西必须能被统计页的解析器原样读回来。
    const entries = parseUsageLedger(readFileSync(path, 'utf-8'));
    expect(entries).toEqual([
      expect.objectContaining({
        id: 'u1',
        pluginId: 'commit',
        purpose: '写提交说明',
        cwd: '/repo',
        model: 'deepseek-chat',
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 10,
      }),
      expect.objectContaining({ id: 'u2', inputTokens: 20, cachedInputTokens: 0 })
    ]);
  });

  it('falls back to the run time when a provider record has no timestamp', () => {
    const path = ledgerPath();
    appendPluginUsage({
      pluginId: 'commit',
      purpose: null,
      cwd: null,
      path,
      fallbackAt: '2026-10-02T08:00:00.000Z',
      requests: [
        usage({
          usageId: 'legacy',
          model: 'm',
          occurredAt: undefined,
          inputTokens: 5,
          outputTokens: 1,
          totalTokens: 6,
        }),
      ],
    });

    expect(parseUsageLedger(readFileSync(path, 'utf-8'))).toEqual([
      expect.objectContaining({ id: 'legacy', occurredAt: '2026-10-02T08:00:00.000Z' }),
    ]);
  });

  it('writes nothing when no request can be dated', () => {
    const path = ledgerPath();
    const written = appendPluginUsage({
      pluginId: 'commit',
      purpose: null,
      cwd: null,
      path,
      requests: [usage({ usageId: 'undated', model: 'm', inputTokens: 5, totalTokens: 5, occurredAt: '' })],
    });

    expect(written).toBe(0);
    expect(() => readFileSync(path, 'utf-8')).toThrow();
  });
});
