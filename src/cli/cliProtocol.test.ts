import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('CLI runtime probes', () => {
  it('reports a version without creating or loading user config', () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-version-probe-'));
    try {
      const result = runCli(['--version'], micaHome);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toMatch(/^mica-code \S+$/);
      expect(result.stderr).toBe('');
      expect(existsSync(join(micaHome, 'config.json'))).toBe(false);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('prints provider-qualified models in the format Multica discovers', () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-model-probe-'));
    try {
      writeFileSync(
        join(micaHome, 'config.json'),
        `${JSON.stringify({
          providers: [
            {
              id: 'deepseek',
              api_base: 'https://example.com',
              api_key: 'x',
              protocol: 'openai_chat_completions',
              models: ['deepseek-chat'],
            },
            {
              id: 'openrouter',
              api_base: 'https://example.com',
              api_key: 'x',
              protocol: 'openai_responses',
              models: ['openai/gpt-5'],
            },
          ],
        })}\n`,
        'utf-8',
      );

      const result = runCli(['models'], micaHome);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().split('\n')).toEqual(['deepseek/deepseek-chat', 'openrouter/openai/gpt-5']);
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });

  it('keeps exec-mode startup failures as a single valid JSON error line', () => {
    const micaHome = mkdtempSync(join(tmpdir(), 'mica-run-probe-'));
    try {
      const result = runCli(
        ['exec', '--json', '--mcp-init-timeout-ms', '3000', '--dir', join(micaHome, 'missing'), 'test'],
        micaHome,
      );
      expect(result.status).toBe(2);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        type: 'error',
      });
    } finally {
      rmSync(micaHome, { recursive: true, force: true });
    }
  });
});

function runCli(args: string[], micaHome: string) {
  return spawnSync('bun', ['run', 'src/index.ts', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, MICA_HOME: micaHome },
    encoding: 'utf-8',
  });
}
