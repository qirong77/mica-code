import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { PluginAskAnswer, PluginAskApi, PluginAskQuestion } from '@packages/mica-plugin/index.js';
import { resolvePluginAskDisplay } from '@packages/mica-plugin/index.js';
import { AskUserTool } from './AskTool.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

function fakeCommand() {
  const child = Object.assign(new EventEmitter(), {
    pid: 424_242,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(child as never);
  return child;
}

function stubAsk(answer: PluginAskAnswer) {
  const seen: PluginAskQuestion[] = [];
  const api: PluginAskApi = {
    request: async (question) => {
      seen.push(question);
      return answer;
    },
    post: () => {
      throw new Error('ask_user 只用阻塞提问');
    },
  };
  return { api, seen };
}

const question = {
  title: '先做哪个入口？',
  options: [
    { id: 'a', label: '方案 A', prompt: '先做转账入口' },
    { id: 'b', label: '方案 B' },
  ],
};

describe('AskUserTool', () => {
  beforeEach(() => { vi.mocked(spawn).mockReset(); });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is a write/execute barrier even when a particular question has no commands', () => {
    expect(new AskUserTool(stubAsk({ optionIds: [], cancelled: true, reason: 'cancelled' }).api).readOnly).toBe(false);
  });

  it('turns a picked option into an instruction the model can act on', async () => {
    const { api, seen } = stubAsk({ optionIds: ['a'], cancelled: false, reason: 'answered' });
    const text = await new AskUserTool(api).execute(question);
    expect(seen[0].title).toBe('先做哪个入口？');
    expect(text).toContain('用户选择了「方案 A」');
    // 选项上的 prompt 变成「按这个选项继续」的指令段落。
    expect(text).toContain('先做转账入口');
    expect(text).toBe('用户选择了「方案 A」。\n\n按这个选项继续：先做转账入口');
  });

  it('lists every option when several were picked', async () => {
    const { api } = stubAsk({ optionIds: ['a', 'b'], cancelled: false, reason: 'answered' });
    const text = await new AskUserTool(api).execute({ ...question, multiple: true });
    expect(text).toContain('「方案 A」');
    expect(text).toContain('「方案 B」');
  });

  it('passes the free-text answer through', async () => {
    const { api } = stubAsk({
      optionIds: [],
      custom: '都不做，先补文档',
      cancelled: false,
      reason: 'answered',
    });
    const text = await new AskUserTool(api).execute(question);
    expect(text).toContain('用户的补充：都不做，先补文档');
  });

  it('never forwards a switch for the free-text field', async () => {
    const { api, seen } = stubAsk({ optionIds: ['a'], cancelled: false, reason: 'answered' });
    await new AskUserTool(api).execute(question);
    const legacy = (value: PluginAskQuestion) => value as unknown as Record<string, unknown>;
    expect(legacy(seen[0]!).allowCustom).toBeUndefined();
    // 老 schema 里的 `allowCustom` / `ui.input` 不再往下传：输入框没有开关。
    await new AskUserTool(api).execute({ ...question, allowCustom: false, ui: { input: false } });
    expect(legacy(seen[1]!).allowCustom).toBeUndefined();
    // `ui` 是整块透传的；`input: false` 传到显示层也不再生效（恒为 true）
    expect(resolvePluginAskDisplay(seen[1]).input).toBe(true);
  });

  it('tells the model not to re-ask after a cancellation', async () => {
    const { api } = stubAsk({ optionIds: [], cancelled: true, reason: 'timeout' });
    const text = await new AskUserTool(api).execute(question);
    expect(text).toContain('没有回应');
    expect(text).toContain('不要重复问同一个问题');
    expect(text).toContain('已超时');
    expect(text).toContain('实现第一版');
    expect(text).toContain('不要自动执行选项里的 command');
  });

  it('defaults to five minutes and reads the configured timeout for each question', async () => {
    const { api, seen } = stubAsk({ optionIds: ['b'], cancelled: false, reason: 'answered' });
    await new AskUserTool(api).execute(question);
    expect(seen[0].timeoutMs).toBe(300_000);

    let timeoutMs = 120_000;
    const tool = new AskUserTool(api, { getTimeoutMs: () => timeoutMs });
    await tool.execute(question);
    timeoutMs = 600_000;
    await tool.execute(question);
    expect(seen.slice(1).map((item) => item.timeoutMs)).toEqual([120_000, 600_000]);
  });

  it('keeps a positive per-call timeout and falls back for invalid values', async () => {
    const { api, seen } = stubAsk({ optionIds: ['b'], cancelled: false, reason: 'answered' });
    const tool = new AskUserTool(api, { getTimeoutMs: () => 120_000 });
    await tool.execute({ ...question, timeoutMs: 1000 });
    for (const timeoutMs of [null, '', 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await tool.execute({ ...question, timeoutMs });
    }
    expect(seen[0].timeoutMs).toBe(1000);
    expect(seen.slice(1).every((item) => item.timeoutMs === 120_000)).toBe(true);
    await new AskUserTool(api, { getTimeoutMs: () => Number.NaN }).execute(question);
    expect(seen.at(-1)?.timeoutMs).toBe(300_000);
  });

  it('notifies the captured owner on timeout without treating an option as selected', async () => {
    const { api } = stubAsk({ optionIds: ['a'], cancelled: true, reason: 'timeout' });
    const context = {};
    const owner = {};
    const captureOwner = vi.fn(() => owner);
    const onTimeout = vi.fn();
    const signal = new AbortController().signal;
    const request = vi.spyOn(api, 'request');
    const text = await new AskUserTool(api, { captureOwner, onTimeout }).execute(question, {
      context,
      signal,
    });
    expect(captureOwner).toHaveBeenCalledWith(context);
    expect(request).toHaveBeenCalledWith(expect.anything(), { signal });
    expect(onTimeout).toHaveBeenCalledWith(expect.stringContaining('等待回复已超时'), owner);
    expect(onTimeout).toHaveBeenCalledWith(expect.stringContaining('先按保守方案实现第一版'), owner);
    expect(text).not.toContain('先做转账入口');
    expect(text).toContain('不代表用户选择了任何选项或批准了任何操作');
    expect(text).not.toContain('用户选择了「方案 A」');
  });

  it.each(['cancelled', 'aborted'] as const)('does not report %s as a timeout', async (reason) => {
    const { api } = stubAsk({ optionIds: ['a'], cancelled: true, reason });
    const onTimeout = vi.fn();
    const tool = new AskUserTool(api, { onTimeout });
    const text = await tool.execute(question);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(text).not.toContain('超时');
    expect(text).not.toContain('实现第一版');
    expect(text).not.toContain('先做转账入口');
    expect(text).toContain('不代表用户选择了任何选项或批准了任何操作');
    expect(text).toContain('安全、可逆');
    expect(tool.description).toContain('Cancellation is not a choice or authorization');
  });

  it('does not issue a timeout notice after the user answers', async () => {
    const { api } = stubAsk({ optionIds: ['a'], cancelled: false, reason: 'answered' });
    const onTimeout = vi.fn();
    await new AskUserTool(api, { onTimeout }).execute(question);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('reports a broken question instead of throwing at the model', async () => {
    const api: PluginAskApi = {
      request: async () => {
        throw new Error('提问缺少 title');
      },
      post: () => {
        throw new Error('ask_user 只用阻塞提问');
      },
    };
    const text = await new AskUserTool(api).execute({ title: '' });
    expect(text).toContain('提问缺少 title');
  });

  it('shows the question in the tool row while it waits', () => {
    expect(
      new AskUserTool(stubAsk({ optionIds: [], cancelled: true, reason: 'aborted' }).api).onToolUseDisplayText(
        question,
      ),
    ).toBe('Asking: 先做哪个入口？');
  });

  it('captures the initiating owner cwd before waiting and forwards the turn signal to the child', async () => {
    const { api } = stubAsk({ optionIds: ['a'], cancelled: false, reason: 'answered' });
    const owner = {};
    const context = {};
    let cwd = '/workspace/original-owner';
    const getCwd = vi.fn(() => cwd);
    vi.spyOn(api, 'request').mockImplementation(async () => {
      cwd = '/workspace/another-session';
      return { optionIds: ['a'], cancelled: false, reason: 'answered' };
    });
    const signal = new AbortController().signal;
    const child = fakeCommand();
    const tool = new AskUserTool(api, { captureOwner: () => owner, getCwd });
    const pending = tool.execute({ title: '执行哪一项？', options: [{ id: 'a', label: '运行检查', command: 'fake-command' }] }, { context, signal });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(getCwd).toHaveBeenCalledExactlyOnceWith(owner);
    expect(spawn).toHaveBeenCalledWith('/bin/bash', ['-lc', 'fake-command'], expect.objectContaining({
      cwd: '/workspace/original-owner', signal, detached: process.platform !== 'win32',
    }));
    child.stdout.emit('data', Buffer.from('fake output'));
    child.emit('close', 0, null);
    expect(JSON.parse(await pending)).toMatchObject({ outcome: 'success', code: 'ok', commands: [
      { optionId: 'a', outcome: 'success', code: 'ok', exitCode: 0, output: 'fake output' },
    ] });
  });

  it('does not fall back to an unrelated process cwd when the owner has no cwd', async () => {
    const { api } = stubAsk({ optionIds: ['a'], cancelled: false, reason: 'answered' });
    const result = await new AskUserTool(api, { getCwd: () => undefined }).execute({
      title: '执行哪一项？', options: [{ id: 'a', label: '运行检查', command: 'must-not-run' }],
    });
    expect(JSON.parse(result)).toMatchObject({ outcome: 'error', code: 'cwd_unavailable' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('waits for aborted child cleanup, kills the detached group and never starts the next selected command', async () => {
    const { api } = stubAsk({ optionIds: ['a', 'b'], cancelled: false, reason: 'answered' });
    const child = fakeCommand();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const controller = new AbortController();
    const pending = new AskUserTool(api).execute({
      title: '执行哪些项？', multiple: true,
      options: [{ id: 'a', label: '第一项', command: 'fake-first' }, { id: 'b', label: '第二项', command: 'must-not-run' }],
    }, { signal: controller.signal, context: { cwd: '/workspace/owner' } });
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    controller.abort();
    child.emit('error', new DOMException('The operation was aborted', 'AbortError'));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    child.emit('close', null, 'SIGTERM');
    const result = JSON.parse(await pending);
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    expect(result).toMatchObject({ outcome: 'cancelled', code: 'aborted', commands: [
      { optionId: 'a', outcome: 'cancelled', code: 'aborted', aborted: true },
    ] });
    expect(spawn).toHaveBeenCalledOnce();
    expect(result.text).not.toContain('must-not-run');
  });

  it('checks the signal again between a successful command and the next selection', async () => {
    const { api } = stubAsk({ optionIds: ['a', 'b'], cancelled: false, reason: 'answered' });
    const child = fakeCommand();
    const controller = new AbortController();
    const pending = new AskUserTool(api).execute({
      title: '执行哪些项？', multiple: true,
      options: [{ id: 'a', label: '第一项', command: 'fake-success' }, { id: 'b', label: '第二项', command: 'must-not-run' }],
    }, { signal: controller.signal });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.emit('close', 0, null);
    controller.abort();
    expect(JSON.parse(await pending)).toMatchObject({ outcome: 'cancelled', code: 'aborted', commands: [
      { optionId: 'a', outcome: 'success', code: 'ok' },
    ] });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('escalates a timed-out fake child and reports a fixed terminal outcome without running later options', async () => {
    vi.useFakeTimers();
    const { api } = stubAsk({ optionIds: ['a', 'b'], cancelled: false, reason: 'answered' });
    const child = fakeCommand();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const pending = new AskUserTool(api).execute({
      title: '执行哪些项？', multiple: true,
      options: [{ id: 'a', label: '第一项', command: 'fake-hold' }, { id: 'b', label: '第二项', command: 'must-not-run' }],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(500);
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    child.emit('close', null, 'SIGKILL');
    expect(JSON.parse(await pending)).toMatchObject({ outcome: 'timeout', code: 'timeout', commands: [
      { outcome: 'timeout', code: 'timeout', timedOut: true, aborted: false },
    ] });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('keeps nonzero exit and spawn failures structural, with no retries or subsequent commands', async () => {
    const { api } = stubAsk({ optionIds: ['a', 'b'], cancelled: false, reason: 'answered' });
    const child = fakeCommand();
    const question = { title: '执行哪些项？', multiple: true, options: [
      { id: 'a', label: '第一项', command: 'fake-failure' }, { id: 'b', label: '第二项', command: 'must-not-run' },
    ] };
    const pending = new AskUserTool(api).execute(question);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stderr.emit('data', Buffer.from('fake failure'));
    child.emit('close', 3, null);
    expect(JSON.parse(await pending)).toMatchObject({ outcome: 'error', code: 'nonzero_exit', commands: [
      { exitCode: 3, output: 'fake failure' },
    ] });
    expect(spawn).toHaveBeenCalledOnce();
    vi.mocked(spawn).mockImplementationOnce(() => { throw new Error('fake spawn failure'); });
    expect(JSON.parse(await new AskUserTool(api).execute(question))).toMatchObject({ outcome: 'error', code: 'spawn_failed' });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('checks cancellation before asking and again after an answer, without starting a command', async () => {
    const { api } = stubAsk({ optionIds: ['a'], cancelled: false, reason: 'answered' });
    const request = vi.spyOn(api, 'request');
    const controller = new AbortController();
    controller.abort();
    const tool = new AskUserTool(api);
    expect(JSON.parse(await tool.execute(question, { signal: controller.signal }))).toMatchObject({ outcome: 'cancelled', code: 'aborted' });
    expect(request).not.toHaveBeenCalled();
    const duringAnswer = new AbortController();
    request.mockImplementation(async () => {
      duringAnswer.abort();
      return { optionIds: ['a'], cancelled: false, reason: 'answered' };
    });
    expect(JSON.parse(await tool.execute({ ...question, options: [{ id: 'a', label: '第一项', command: 'must-not-run' }] }, { signal: duringAnswer.signal })))
      .toMatchObject({ outcome: 'cancelled', code: 'aborted' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ['timeout', 'timeout', 'answer_timeout'],
    ['cancelled', 'cancelled', 'answer_cancelled'],
    ['aborted', 'cancelled', 'aborted'],
  ] as const)('reports %s structurally without executing selected commands', async (reason, outcome, code) => {
    const { api } = stubAsk({ optionIds: ['a'], cancelled: true, reason });
    const result = await new AskUserTool(api).execute({ ...question, options: [{ id: 'a', label: '第一项', command: 'must-not-run' }] });
    expect(JSON.parse(result)).toMatchObject({ outcome, code });
    expect(spawn).not.toHaveBeenCalled();
  });
});
