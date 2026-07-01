import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CommandAgent } from './services.js';

const previousHome = process.env.HOME;
const previousMicaHome = process.env.MICA_HOME;
const tempHome = mkdtempSync(join(tmpdir(), 'mica-doctor-'));
let doctorApi: typeof import('./doctor.js');

beforeAll(async () => {
  process.env.HOME = tempHome;
  process.env.MICA_HOME = tempHome;
  vi.resetModules();
  doctorApi = await import('./doctor.js');
});

afterAll(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  if (previousMicaHome === undefined) {
    delete process.env.MICA_HOME;
  } else {
    process.env.MICA_HOME = previousMicaHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
});

describe('doctor command report', () => {
  it('summarizes a healthy local setup', async () => {
    const report = await doctorApi.buildDoctorReport(makeAgent(), {
      config: baseConfig(),
      configPath: join(tempHome, 'config.json'),
      cwd: tempHome,
      env: { SERPER_API_KEY: 'serper-key' },
      gitText: healthyGit,
      mcpConfig: {
        local: { command: 'node', args: ['server.js'] },
      },
      mcpStatuses: [
        {
          name: 'local',
          url: 'node server.js',
          configPath: join(tempHome, 'config.json'),
          status: 'connected',
          toolCount: 2,
          tools: [],
        },
      ],
      now: new Date('2026-01-02T03:04:05Z'),
      sessionDir: join(tempHome, 'sessions-ok'),
      storagePath: join(tempHome, 'storage.json'),
      toolCounts: { builtin: 13, mcp: 2, total: 15 },
      versions: { node: '22.0.0', bun: '1.2.3' },
    });

    expect(report.generatedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(report.summary.error).toBe(0);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'runtime', status: 'ok', detail: 'Node 22.0.0; Bun 1.2.3' }),
        expect.objectContaining({ id: 'provider-api-key', status: 'ok' }),
        expect.objectContaining({ id: 'web-search', status: 'ok', detail: 'serperApiKey configured' }),
        expect.objectContaining({ id: 'mcp', status: 'ok', detail: '1/1 connected' }),
        expect.objectContaining({ id: 'git', status: 'ok', detail: 'main; clean' }),
      ]),
    );
  });

  it('surfaces actionable warnings without double-counting a missing provider api key as config warning', async () => {
    const config = {
      ...baseConfig(),
      serperApiKey: '',
      providers: [{ ...baseConfig().providers[0]!, api_key: '' }],
    };

    const report = await doctorApi.buildDoctorReport(makeAgent(), {
      config,
      configPath: join(tempHome, 'config.json'),
      cwd: tempHome,
      env: {},
      gitText: healthyGit,
      mcpConfig: {
        broken: { command: 'missing-command' },
      },
      mcpStatuses: [
        {
          name: 'broken',
          url: 'missing-command',
          configPath: join(tempHome, 'config.json'),
          status: 'failed',
          toolCount: 0,
          tools: [],
          error: 'spawn ENOENT',
        },
      ],
      sessionDir: join(tempHome, 'sessions-warn'),
      storagePath: join(tempHome, 'storage.json'),
      toolCounts: { builtin: 13, mcp: 0, total: 13 },
      versions: { node: '22.0.0', bun: '1.2.3' },
    });

    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'config-validation', status: 'ok' }),
        expect.objectContaining({
          id: 'provider-api-key',
          status: 'warn',
          suggestion: expect.stringContaining('api_key'),
        }),
        expect.objectContaining({
          id: 'web-search',
          status: 'warn',
          suggestion: expect.stringContaining('SERPER_API_KEY'),
        }),
        expect.objectContaining({ id: 'mcp', status: 'warn', detail: expect.stringContaining('failed: broken') }),
      ]),
    );
  });

  it('reports runtime and config errors', async () => {
    const report = await doctorApi.buildDoctorReport(makeAgent(), {
      config: {
        ...baseConfig(),
        provider: 'missing',
      },
      cwd: tempHome,
      env: { SERPER_API_KEY: 'serper-key' },
      gitText: healthyGit,
      mcpConfig: {},
      mcpStatuses: [],
      sessionDir: join(tempHome, 'sessions-error'),
      storagePath: join(tempHome, 'storage.json'),
      toolCounts: { builtin: 13, mcp: 0, total: 13 },
      versions: { node: '20.0.0' },
    });

    expect(report.summary.error).toBeGreaterThanOrEqual(2);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'runtime',
          status: 'error',
          suggestion: expect.stringContaining('Node.js >=22'),
        }),
        expect.objectContaining({ id: 'config-validation', status: 'error' }),
        expect.objectContaining({ id: 'provider', status: 'error' }),
      ]),
    );
  });
});

function healthyGit(args: string[]): string {
  if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true\n';
  if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main\n';
  if (args[0] === 'status' && args[1] === '--porcelain') return '';
  throw new Error(`unexpected git args: ${args.join(' ')}`);
}

function makeAgent(): CommandAgent {
  return {
    config: {
      provider: {
        id: 'deepseek',
        name: 'DeepSeek',
        api_base: 'https://api.deepseek.com',
        api_key: 'test-key',
        contextWindowSize: 1000,
      },
      model: 'deepseek-chat',
      effort: 'none',
    },
    currentRunId: 1,
    isRunning: false,
    reloadConfig: vi.fn(),
    createSubAgent: vi.fn(),
    getSnapshot: () => ({
      providerId: 'deepseek',
      model: 'deepseek-chat',
      effort: 'none',
      messages: [],
      usageHistory: [],
    }),
  } as unknown as CommandAgent;
}

function baseConfig() {
  return {
    provider: 'deepseek',
    model: 'deepseek-chat',
    effort: 'none' as const,
    contextWindowSize: 1000,
    serperApiKey: 'serper-key',
    providers: [
      {
        id: 'deepseek',
        name: 'DeepSeek',
        api_base: 'https://api.deepseek.com',
        api_key: 'test-key',
        protocol: 'openai_chat_completions' as const,
        models: ['deepseek-chat'],
      },
    ],
  };
}
