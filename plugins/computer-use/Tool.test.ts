import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PluginAskAnswer, PluginAskApi, PluginAskQuestion } from '@packages/mica-plugin/index.js';
import { COMPUTER_USE_TOOL_NAME, createComputerUseTool, describeStep } from './Tool.js';

/**
 * 这个文件只验证工具的**约定**：什么会问用户、许可文件里写的是什么、命令怎么派发。
 * 真门禁在 runtime（`runtime.test.ts`）——工具这边只是把「用户批准了什么」写成一份许可。
 */

const STUB_RUNTIME = `
import { appendFileSync, readFileSync } from 'node:fs';
const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'commands') {
  process.stdout.write(JSON.stringify({ write: ['tap', 'move', 'type'], read: ['screens', 'pos', 'text'] }));
  process.exit(0);
}
const permit = process.env.MICA_COMPUTER_USE_APPROVAL || '';
appendFileSync(process.env.CU_LOG, JSON.stringify({
  cmd, args, permit,
  permitBody: permit ? JSON.parse(readFileSync(permit, 'utf8')) : null,
}) + '\\n');
if (process.env.CU_FAIL_ON === cmd) { process.stderr.write('boom'); process.exit(3); }
process.stdout.write('ok ' + cmd);
`;

const tempDirs: string[] = [];

function workspace(): { runtimeDir: string; logFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mica-cu-tool-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'desktop.mjs'), STUB_RUNTIME, 'utf-8');
  return { runtimeDir: dir, logFile: join(dir, 'calls.jsonl') };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.CU_LOG;
});

type AskStub = PluginAskApi & { calls: PluginAskQuestion[] };

function askStub(answer: Partial<PluginAskAnswer>): AskStub {
  const calls: PluginAskQuestion[] = [];
  return {
    calls,
    request: async (question: PluginAskQuestion) => {
      calls.push(question);
      return { optionIds: ['allow'], cancelled: false, reason: 'answered', ...answer };
    },
    post: () => {
      throw new Error('post is not used by this tool');
    },
  };
}

function tool(deps: { runtimeDir: string; ask?: PluginAskApi }) {
  return createComputerUseTool({ ...deps, nodeBin: process.execPath });
}

function calls(logFile: string): Array<{ cmd: string; args: string[]; permit: string; permitBody: unknown }> {
  try {
    return readFileSync(logFile, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

describe('computer_use tool', () => {
  it('runs read-only commands without asking the user', async () => {
    const { runtimeDir, logFile } = workspace();
    const ask = askStub({});
    process.env.CU_LOG = logFile;

    const result = await tool({ runtimeDir, ask }).execute!({
      commands: [
        { cmd: 'screens' },
        { cmd: 'text', args: ['Calculator'] },
      ],
    });

    expect(ask.calls).toHaveLength(0);
    expect(result).toContain('ok screens');
    expect(result).toContain('ok text');
    const logged = calls(logFile);
    expect(logged.map((entry) => entry.cmd)).toEqual(['screens', 'text']);
    // 只读命令不给许可：runtime 那边也不会消费任何许可
    expect(logged.every((entry) => entry.permit === '')).toBe(true);
  });

  it('asks before a batch that touches the mouse or keyboard, then hands out a per-step permit', async () => {
    const { runtimeDir, logFile } = workspace();
    const ask = askStub({});
    process.env.CU_LOG = logFile;

    const result = await tool({ runtimeDir, ask }).execute!({
      goal: '在计算器里算 123×456',
      commands: [
        { cmd: 'tap', args: ['Calculator', '1'] },
        { cmd: 'type', args: ['123'] },
      ],
    });

    expect(ask.calls).toHaveLength(1);
    const question = ask.calls[0]!;
    expect(question.title).toContain('在计算器里算 123×456');
    expect(question.detail).toContain('点击「Calculator」里的「1」');
    expect(question.detail).toContain('键入 "123"');
    expect(question.options.map((option) => option.id)).toEqual(['allow', 'deny']);
    expect(question.allowCustom).toBe(false);

    expect(result).toContain('ok tap');
    const logged = calls(logFile);
    expect(logged).toHaveLength(2);
    const permit = logged[0]!.permitBody as { v: number; entries: Array<{ key: string; used: boolean }> };
    expect(permit.v).toBe(1);
    expect(permit.entries.map((entry) => entry.key)).toEqual([
      JSON.stringify(['tap', 'Calculator', '1']),
      JSON.stringify(['type', '123']),
    ]);
  });

  it('runs nothing when the user declines', async () => {
    const { runtimeDir, logFile } = workspace();
    const ask = askStub({ optionIds: ['deny'] });
    process.env.CU_LOG = logFile;

    const result = await tool({ runtimeDir, ask }).execute!({
      goal: '点一下设置',
      commands: [{ cmd: 'tap', args: ['Finder', '设置'] }],
    });

    expect(result).toContain('没有执行');
    expect(calls(logFile)).toHaveLength(0);
  });

  it('runs nothing when the confirmation times out', async () => {
    const { runtimeDir, logFile } = workspace();
    const ask = askStub({ optionIds: [], cancelled: true, reason: 'timeout' });
    process.env.CU_LOG = logFile;

    const result = await tool({ runtimeDir, ask }).execute!({
      commands: [{ cmd: 'move', args: ['10', '20'] }],
    });

    expect(result).toContain('没有回应');
    expect(calls(logFile)).toHaveLength(0);
  });

  it('refuses write commands in a host that cannot ask, but still allows reads', async () => {
    const { runtimeDir, logFile } = workspace();
    process.env.CU_LOG = logFile;

    const refused = await tool({ runtimeDir }).execute!({ commands: [{ cmd: 'type', args: ['hi'] }] });
    expect(refused).toContain('写操作被拒绝');
    expect(calls(logFile)).toHaveLength(0);

    const allowed = await tool({ runtimeDir }).execute!({ commands: [{ cmd: 'pos' }] });
    expect(allowed).toContain('ok pos');
  });

  it('rejects unknown commands before running anything', async () => {
    const { runtimeDir, logFile } = workspace();
    const ask = askStub({});
    process.env.CU_LOG = logFile;

    const result = await tool({ runtimeDir, ask }).execute!({ commands: [{ cmd: 'eval', args: ['1+1'] }] });

    expect(result).toContain('未知命令');
    expect(ask.calls).toHaveLength(0);
    expect(calls(logFile)).toHaveLength(0);
  });

  it('stops at the first failing step and says what was skipped', async () => {
    const { runtimeDir, logFile } = workspace();
    process.env.CU_LOG = logFile;
    process.env.CU_FAIL_ON = 'type';
    try {
      const result = await tool({ runtimeDir, ask: askStub({}) }).execute!({
        commands: [{ cmd: 'tap', args: ['Calculator', '1'] }, { cmd: 'type', args: ['1'] }, { cmd: 'pos' }],
      });
      expect(result).toContain('exit=3');
      expect(result).toContain('boom');
      expect(result).toContain('后面的 1 步没有执行');
    } finally {
      delete process.env.CU_FAIL_ON;
    }
  });

  it('explains the shape when commands are missing', async () => {
    const { runtimeDir } = workspace();
    const result = await tool({ runtimeDir }).execute!({});
    expect(result).toContain('缺少 commands');
  });

  it('describes each step in a way the user can judge', () => {
    expect(describeStep({ cmd: 'focus', args: ['Safari'] })).toContain('切到前台');
    expect(describeStep({ cmd: 'press', args: ['cmd+s'] })).toBe('按组合键 cmd+s');
    expect(describeStep({ cmd: 'click', args: [] })).toBe('点击鼠标当前位置');
    expect(describeStep({ cmd: 'clip', args: ['x'] })).toContain('剪贴板');
    expect(COMPUTER_USE_TOOL_NAME).toBe('computer_use');
  });
});
