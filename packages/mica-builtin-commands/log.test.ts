import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { micaLogger } from '@packages/mica-logger/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import { createLogCommand } from './log.js';
import type { CommandAgent, CommandRuntimeServices } from './services.js';

describe('log export command', () => {
  beforeEach(() => {
    micaLogger.clearRuntimeLogs();
    micaUi.panels.clearLogEntries();
    micaUi.panels.clearAgentTurnLogItems();
    micaUi.panels.thinkingText.set('');
    micaUi.conversation.clearMessages();
    micaUi.conversation.clearResponseText();
    micaUi.conversation.clearPendingInput();
  });

  it('exports runtime logs even when the current conversation is empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-log-export-test-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(dir);
      micaLogger.logRuntime('test', 'startup:error', { reason: 'boom' }, 'error');
      const services = createServices();
      createLogCommand(createAgent({ messages: [] }), services).action('export');

      const exportDir = findExportDir(dir);
      const exportedFiles = readdirSync(exportDir);
      const manifest = readJson(join(exportDir, 'manifest.log'));
      const runtimeLogs = readJson(join(exportDir, 'runtime-logs.log'));
      const conversation = readJson(join(exportDir, 'conversation.log'));

      expect(exportedFiles.every((name) => name.endsWith('.log'))).toBe(true);
      expect(manifest.counts.messages).toBe(0);
      expect(manifest.files).toEqual([
        'manifest.log',
        'diagnostics.log',
        'runtime.log',
        'runtime-logs.log',
        'turn-log.log',
        'conversation.log',
      ]);
      expect(conversation.totalMessages).toBe(0);
      expect(runtimeLogs.entries).toEqual(
        expect.arrayContaining([expect.objectContaining({ scope: 'test', message: 'startup:error' })]),
      );
      expect(readFileSync(join(exportDir, 'runtime.log'), 'utf-8')).toContain('startup:error');
      expect(services.showMessage).toHaveBeenCalledWith(expect.stringContaining('运行日志'), 8000);
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('omits image base64 and truncates huge exported strings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mica-log-export-test-'));
    const previousCwd = process.cwd();
    try {
      process.chdir(dir);
      createLogCommand(
        createAgent({
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: `head-${'x'.repeat(140_000)}-tail` },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(256) } },
              ],
            },
          ],
        }),
        createServices(),
      ).action('export');

      const conversation = readJson(join(findExportDir(dir), 'conversation.log'));
      const content = conversation.turns[0].messages[0].content;

      expect(content[0].text).toContain('[export truncated');
      expect(content[1].source.data).toContain('[base64 omitted');
      expect(content[1].source.data).not.toContain('aaaaaaaaaaaaaaaa');
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function createAgent(snapshot: Partial<ReturnType<CommandAgent['getSnapshot']>> = {}): CommandAgent {
  return {
    config: {
      effort: 'none',
      model: 'test-model',
      provider: {
        contextWindowSize: 1000,
        id: 'test-provider',
        name: 'Test Provider',
        supportsEffort: false,
      },
    },
    createSubAgent: vi.fn(),
    currentRunId: 1,
    getSnapshot: () => ({
      effort: 'none',
      lastUsage: undefined,
      messages: [],
      model: 'test-model',
      providerId: 'test-provider',
      usageHistory: [],
      ...snapshot,
    }),
    isRunning: false,
    reloadConfig: vi.fn(),
  } as unknown as CommandAgent;
}

function createServices(): CommandRuntimeServices {
  return {
    showMessage: vi.fn(),
  } as unknown as CommandRuntimeServices;
}

function findExportDir(dir: string): string {
  const entry = readdirSync(dir).find((name) => name.startsWith('mica-log-export-'));
  if (!entry) throw new Error('export directory not found');
  return join(dir, entry);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'));
}
