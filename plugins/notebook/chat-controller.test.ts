import { describe, expect, it, vi } from 'vitest';
import { createNotebookChat } from './chat-controller.js';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };
type SessionStatus = {
  running: boolean;
  events: unknown[];
  prompt?: string;
  startedAt?: number;
  finished?: boolean;
  remoteRunning?: boolean;
  exit?: { error?: string };
};
type SendInput = { sessionId: string; cwd: string | null; prompt: string; clientMessageId: string };
type SendResult = { ok: boolean; error?: string; queued?: boolean };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeSessions() {
  let eventHandler: ((id: string, event: unknown, payload?: unknown) => void) | undefined;
  let exitHandler: ((payload: unknown) => void) | undefined;
  let queueErrorHandler: ((payload: unknown) => void) | undefined;
  let runStartedHandler: ((payload: unknown) => void) | undefined;
  let queueStateHandler: ((payload: unknown) => void) | undefined;
  const unsubscriptions = Array.from({ length: 5 }, () => vi.fn());
  const sessions = {
    history: vi.fn(async (_id: string) => [] as Array<{ role: string; text: string }>),
    isRunning: vi.fn(async (_id: string): Promise<SessionStatus> => ({ running: false, events: [] })),
    send: vi.fn(async (_input: SendInput): Promise<SendResult> => ({ ok: true })),
    abort: vi.fn(async () => ({ ok: true })),
    onEvent: vi.fn((callback: typeof eventHandler) => {
      eventHandler = callback!;
      return () => {
        unsubscriptions[0]();
        if (eventHandler === callback) eventHandler = undefined;
      };
    }),
    onExit: vi.fn((callback: typeof exitHandler) => {
      exitHandler = callback!;
      return () => {
        unsubscriptions[1]();
        if (exitHandler === callback) exitHandler = undefined;
      };
    }),
    onQueueError: vi.fn((callback: typeof queueErrorHandler) => {
      queueErrorHandler = callback!;
      return () => {
        unsubscriptions[2]();
        if (queueErrorHandler === callback) queueErrorHandler = undefined;
      };
    }),
    onRunStarted: vi.fn((callback: typeof runStartedHandler) => {
      runStartedHandler = callback;
      return () => {
        unsubscriptions[3]();
        runStartedHandler = undefined;
      };
    }),
    onQueueState: vi.fn((callback: typeof queueStateHandler) => {
      queueStateHandler = callback;
      return () => {
        unsubscriptions[4]();
        queueStateHandler = undefined;
      };
    }),
    unsubscriptions,
    emitEvent(id: string, event: unknown, payload: unknown = {}) {
      eventHandler?.(id, event, payload);
    },
    emitExit(payload: unknown) {
      exitHandler?.(payload);
    },
    emitQueueError(payload: unknown) {
      queueErrorHandler?.(payload);
    },
    emitRunStarted(payload: unknown) {
      runStartedHandler?.(payload);
    },
    emitQueueState(payload: unknown) {
      queueStateHandler?.(payload);
    },
  };
  return sessions;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Notebook chat controller', () => {
  it('clears a transient read error after a successful explicit retry', async () => {
    const sessions = fakeSessions();
    sessions.history.mockRejectedValueOnce(new Error('temporary read failure'));
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    expect(controller.getState().error).toBe('temporary read failure');
    await controller.refresh();
    expect(controller.getState().error).toBe('');
    controller.dispose();
  });
  it('starts with the documented state and sends the prompt unchanged', async () => {
    const sessions = fakeSessions();
    const controller = createNotebookChat({ sessions });
    expect(controller.getState()).toEqual({
      sessionId: '',
      messages: [],
      draft: '',
      running: false,
      remoteRunning: false,
      loading: false,
      sending: false,
      stopping: false,
      queuedCount: 0,
      queuedItems: [],
      error: '',
      status: '',
    });

    await controller.select('s1', '/tmp/work');
    controller.setDraft('  原样保留\n\n');
    await controller.send();
    expect(sessions.send).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        cwd: '/tmp/work',
        prompt: '  原样保留\n\n',
      }),
    );
    expect(sessions.send.mock.calls[0][0].prompt).toBe('  原样保留\n\n');
  });

  it('buffers events during delayed history and does not duplicate persisted current-turn output', async () => {
    const sessions = fakeSessions();
    const history = deferred<Array<{ role: string; text: string }>>();
    const status = deferred<{ running: boolean; prompt: string; events: unknown[] }>();
    sessions.history.mockReturnValue(history.promise);
    sessions.isRunning.mockReturnValue(status.promise);
    const controller = createNotebookChat({ sessions });
    const selecting = controller.select('s1');
    sessions.emitEvent('s1', { type: 'text', part: { text: ' world' } }, { sequence: 3 });
    history.resolve([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'world' },
    ]);
    status.resolve({
      running: true,
      prompt: 'hello',
      events: [
        { sequence: 1, event: { type: 'step_start' } },
        { sequence: 2, event: { type: 'text', part: { text: 'hello' } } },
      ],
    });
    await selecting;
    expect(controller.getState().messages).toEqual([
      { id: 'history-0', role: 'user', text: 'hello' },
      { id: expect.any(String), role: 'assistant', text: 'hello world', streaming: true },
    ]);
    expect(controller.getState().running).toBe(true);
  });

  it('guards delayed responses after switching sessions and restores per-session drafts', async () => {
    const sessions = fakeSessions();
    const first = deferred<Array<{ role: string; text: string }>>();
    const second = deferred<Array<{ role: string; text: string }>>();
    sessions.history.mockImplementation((id: string) => (id === 'a' ? first.promise : second.promise));
    const controller = createNotebookChat({ sessions });
    const a = controller.select('a');
    controller.setDraft('draft a');
    const b = controller.select('b');
    first.resolve([{ role: 'assistant', text: 'old session' }]);
    second.resolve([{ role: 'assistant', text: 'new session' }]);
    await Promise.all([a, b]);
    expect(controller.getState().sessionId).toBe('b');
    expect(controller.getState().messages.map((message) => message.text)).toEqual(['new session']);
    await controller.select('a');
    expect(controller.getState().draft).toBe('draft a');
  });

  it('prevents double send and rolls back a failed optimistic message', async () => {
    const sessions = fakeSessions();
    const pending = deferred<{ ok: boolean }>();
    sessions.send.mockReturnValue(pending.promise);
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    controller.setDraft('recover me');
    const first = controller.send();
    const second = controller.send();
    expect(sessions.send).toHaveBeenCalledTimes(1);
    pending.resolve({ ok: false });
    await Promise.all([first, second]);
    expect(controller.getState().messages).toEqual([]);
    expect(controller.getState().draft).toBe('recover me');
    expect(controller.getState().error).toBe('发送失败');
  });

  it('rolls back an asynchronous queue rejection without hiding a newer draft', async () => {
    const sessions = fakeSessions();
    const pending = deferred<{ ok: boolean }>();
    sessions.send.mockReturnValue(pending.promise);
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    controller.setDraft('first');
    const sending = controller.send();
    controller.setDraft('second');
    sessions.emitQueueError({
      id: 's1',
      clientMessageId: controller.getState().messages[0].id,
      prompt: 'first',
      error: 'busy',
    });
    expect(controller.getState().messages).toEqual([]);
    expect(controller.getState().draft).toBe('second');
    expect(controller.getState().error).toContain('first');
    pending.resolve({ ok: true });
    await sending;
  });

  it('allows stop with an empty draft and reports abort failures', async () => {
    const sessions = fakeSessions();
    const abort = deferred<{ ok: boolean }>();
    sessions.abort.mockReturnValue(abort.promise);
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    sessions.emitEvent('s1', { type: 'step_start' }, { sequence: 1 });
    const stopping = controller.stop();
    expect(sessions.abort).toHaveBeenCalledWith('s1');
    expect(controller.getState().stopping).toBe(true);
    abort.resolve({ ok: false });
    await stopping;
    expect(controller.getState().stopping).toBe(false);
    expect(controller.getState().error).toBe('停止失败');
  });

  it('treats the real turn/completed step_finish as terminal and refreshes on exit', async () => {
    const sessions = fakeSessions();
    const history = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { role: 'user', text: 'hi' },
        { role: 'assistant', text: 'done' },
      ]);
    sessions.history.mockImplementation(history);
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    sessions.emitEvent('s1', { type: 'step_start' }, { sequence: 1 });
    sessions.emitEvent('s1', { type: 'step_finish', part: { reason: 'completed' } }, { sequence: 2 });
    expect(controller.getState().running).toBe(false);
    sessions.emitExit({ id: 's1' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle();
    expect(controller.getState().running).toBe(false);
    expect(controller.getState().messages.map((message) => message.text)).toEqual(['hi', 'done']);
  });

  it('blocks send after its acknowledgement while running, and during loading', async () => {
    const sessions = fakeSessions();
    const controller = createNotebookChat({ sessions });
    const reading = controller.select('s1');
    controller.setDraft('not yet');
    await controller.send();
    expect(sessions.send).not.toHaveBeenCalled();
    await reading;
    await controller.send();
    controller.setDraft('next');
    await controller.send();
    expect(sessions.send).toHaveBeenCalledTimes(1);
    expect(controller.getState().draft).toBe('next');
  });

  it('shows cached messages immediately and preserves them when history fails', async () => {
    const sessions = fakeSessions();
    sessions.history.mockResolvedValueOnce([{ role: 'assistant', text: 'cached' }]);
    const controller = createNotebookChat({ sessions });
    await controller.select('a');
    controller.setDraft('draft a');
    await controller.select('b');
    const history = deferred<Array<{ role: string; text: string }>>();
    sessions.history.mockReturnValueOnce(history.promise);
    const selecting = controller.select('a');
    expect(controller.getState().messages.map((row) => row.text)).toEqual(['cached']);
    expect(controller.getState().loading).toBe(false);
    history.reject(new Error('history offline'));
    await selecting;
    expect(controller.getState().messages.map((row) => row.text)).toEqual(['cached']);
    expect(controller.getState().draft).toBe('draft a');
    expect(controller.getState().error).toBe('history offline');
    sessions.history.mockRejectedValueOnce(new Error('still offline'));
    await controller.refresh();
    expect(controller.getState().messages.map((row) => row.text)).toEqual(['cached']);
  });

  it('lets buffered live start/text override an older idle status and deduplicates after load', async () => {
    const sessions = fakeSessions();
    const history = deferred<Array<{ role: string; text: string }>>();
    sessions.history.mockReturnValueOnce(history.promise);
    const controller = createNotebookChat({ sessions });
    const selecting = controller.select('s1');
    sessions.emitEvent('s1', { type: 'step_start', turnId: 'turn-1' }, { sequence: 1 });
    sessions.emitEvent('s1', { type: 'text', part: { text: 'live' } }, { sequence: 2 });
    history.resolve([]);
    await selecting;
    expect(controller.getState().running).toBe(true);
    sessions.emitEvent('s1', { type: 'text', part: { text: 'live' } }, { sequence: 2 });
    expect(controller.getState().messages.map((row) => row.text)).toEqual(['live']);
    sessions.history.mockRejectedValueOnce(new Error('read failed'));
    sessions.isRunning.mockResolvedValueOnce({
      running: true,
      events: [{ sequence: 2, event: { type: 'text', part: { text: 'live' } } }],
    });
    await controller.refresh();
    sessions.emitEvent('s1', { type: 'text', part: { text: 'live' } }, { sequence: 2 });
    expect(controller.getState().messages.map((row) => row.text)).toEqual(['live']);
    sessions.emitEvent('s1', { type: 'step_finish', part: { reason: 'completed' } }, { sequence: 3 });
    sessions.emitEvent('s1', { type: 'step_start', turnId: 'turn-2' }, { sequence: 1 });
    sessions.emitEvent('s1', { type: 'text', part: { text: 'new turn' } }, { sequence: 2 });
    expect(controller.getState().messages.map((row) => row.text)).toEqual(['live', 'new turn']);
  });

  it.each([false, true])('does not append old finished events over durable history (finished=%s)', async (finished) => {
    const sessions = fakeSessions();
    sessions.history.mockResolvedValue([
      { role: 'user', text: 'question' },
      { role: 'assistant', text: 'durable answer' },
    ]);
    sessions.isRunning.mockResolvedValue({
      running: false,
      finished,
      prompt: 'question',
      startedAt: 10,
      events: [
        { sequence: 1, event: { type: 'text', part: { text: 'old answer' } } },
        { sequence: 2, event: { type: 'step_finish', part: { reason: 'completed' } } },
      ],
    });
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    await controller.refresh();
    expect(controller.getState().messages.map((row) => row.text)).toEqual(['question', 'durable answer']);
    sessions.emitEvent('s1', { type: 'text', part: { text: 'old answer' } }, { sequence: 1 });
    expect(controller.getState().running).toBe(false);
    expect(controller.getState().messages.map((row) => row.text)).toEqual(['question', 'durable answer']);
  });

  it('replays finished output only where it has not yet reached disk', async () => {
    const sessions = fakeSessions();
    sessions.history.mockResolvedValue([{ role: 'user', text: 'question' }]);
    sessions.isRunning.mockResolvedValue({
      running: false,
      finished: true,
      prompt: 'question',
      startedAt: 10,
      events: [
        { sequence: 1, event: { type: 'text', part: { text: 'answer' } } },
        { sequence: 2, event: { type: 'step_finish', part: { reason: 'completed' } } },
      ],
    });
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    await controller.refresh();
    expect(controller.getState().messages.map((row) => row.text)).toEqual(['question', 'answer']);
    expect(controller.getState().messages[1].streaming).toBe(false);
    expect(controller.getState().running).toBe(false);
  });

  it('closes a finished snapshot even if host exit left no step_finish in its buffer', async () => {
    const sessions = fakeSessions();
    sessions.isRunning.mockResolvedValue({
      running: false,
      finished: true,
      prompt: 'question',
      startedAt: 10,
      exit: { error: 'host crashed' },
      events: [{ sequence: 1, event: { type: 'text', part: { text: 'partial' } } }],
    });
    const controller = createNotebookChat({ sessions });
    const selecting = controller.select('s1');
    sessions.emitRunStarted({ id: 's1', prompt: 'question', startedAt: 10 });
    await selecting;
    expect(controller.getState()).toMatchObject({ running: false, error: 'host crashed', status: '运行出错' });
    expect(controller.getState().messages.map((row) => row.text)).toEqual(['question', 'partial']);
    expect(controller.getState().messages[1].streaming).toBe(false);
  });

  it('ignores queue errors from other senders and clears owned rejected running/placeholder state', async () => {
    const sessions = fakeSessions();
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    controller.setDraft('mine');
    await controller.send();
    const ownId = sessions.send.mock.calls[0][0].clientMessageId;
    controller.setDraft('new draft');
    sessions.emitQueueError({ id: 's1', clientMessageId: 'someone-else', text: 'not mine', error: 'busy' });
    expect(controller.getState().error).toBe('');
    expect(controller.getState().running).toBe(true);
    sessions.emitQueueError({ id: 's1', clientMessageId: ownId, text: 'host normalized', error: 'busy' });
    expect(controller.getState().draft).toBe('new draft');
    expect(controller.getState().error).toBe('busy（原消息可恢复：mine）');
    expect(controller.getState().messages).toEqual([]);
    expect(controller.getState().running).toBe(false);
    await controller.stop();
    expect(sessions.abort).not.toHaveBeenCalled();
  });

  it.each(['start response', 'queue error'])(
    'restores a failed send to the original session after switching (%s)',
    async (failure) => {
      const sessions = fakeSessions();
      const pending = deferred<{ ok: boolean; error?: string }>();
      sessions.send.mockReturnValue(pending.promise);
      const controller = createNotebookChat({ sessions });
      await controller.select('a');
      controller.setDraft('recover in a');
      const sending = controller.send();
      const id = sessions.send.mock.calls[0][0].clientMessageId;
      await controller.select('b');
      controller.setDraft('keep b');
      if (failure === 'queue error') {
        sessions.emitQueueError({ id: 'a', clientMessageId: id, text: 'recover in a', error: 'busy' });
        pending.resolve({ ok: true });
      } else pending.resolve({ ok: false, error: 'busy' });
      await sending;
      expect(controller.getState().draft).toBe('keep b');
      expect(controller.getState().error).toBe('');
      await controller.select('a');
      expect(controller.getState().draft).toBe('recover in a');
      expect(controller.getState().messages).toEqual([]);
      expect(controller.getState().error).toBe('busy');
    },
  );

  it('keeps unsent drafts when the session cache grows beyond eight sessions', async () => {
    const sessions = fakeSessions();
    const controller = createNotebookChat({ sessions });
    for (let index = 0; index < 9; index += 1) {
      await controller.select(`s${index}`);
      controller.setDraft(`draft ${index}`);
    }
    await controller.select('s1');
    expect(controller.getState().draft).toBe('draft 1');
    await controller.select('s0');
    expect(controller.getState().draft).toBe('draft 0');
  });

  it('exposes remoteRunning and refuses both send and fake successful stop', async () => {
    const sessions = fakeSessions();
    sessions.isRunning.mockResolvedValue({ running: false, remoteRunning: true, events: [] });
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    controller.setDraft('do not send');
    expect(controller.getState().remoteRunning).toBe(true);
    expect(controller.getState().status).toBe('会话正在其他进程运行，无法从此处停止');
    await controller.send();
    await controller.stop();
    expect(sessions.send).not.toHaveBeenCalled();
    expect(sessions.abort).not.toHaveBeenCalled();
    expect(controller.getState().stopping).toBe(false);
    expect(controller.getState().draft).toBe('do not send');
  });

  it('rolls back only the current attempt and closes streaming output at turn completion', async () => {
    const sessions = fakeSessions();
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    const emit = (sequence: number, event: unknown) => sessions.emitEvent('s1', event, { sequence });
    emit(1, { type: 'text', attemptId: 'one', part: { text: 'prior' } });
    emit(2, { type: 'text', attemptId: 'two', part: { text: 'retry' } });
    emit(3, { type: 'text_rollback', attemptId: 'one', length: 100 });
    expect(controller.getState().messages[0].text).toBe('priorretry');
    emit(4, { type: 'text_rollback', attemptId: 'two', length: 100 });
    expect(controller.getState().messages[0].text).toBe('prior');
    emit(5, { type: 'text', attemptId: 'three', part: { text: 'done' } });
    emit(6, { type: 'step_finish', part: { reason: 'aborted' } });
    expect(controller.getState().messages[0]).toMatchObject({ text: 'priordone', streaming: false });
    expect(controller.getState()).toMatchObject({ running: false, stopping: false, status: '已停止' });
  });

  it('adds cross-page user bubbles once without duplicating optimistic sends or equal later turns', async () => {
    const sessions = fakeSessions();
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    controller.setDraft('same prompt');
    await controller.send();
    const ownId = sessions.send.mock.calls[0][0].clientMessageId;
    sessions.emitRunStarted({ id: 's1', clientMessageId: ownId, prompt: 'same prompt', startedAt: 10 });
    sessions.emitRunStarted({ id: 's1', clientMessageId: ownId, prompt: 'same prompt', startedAt: 10 });
    expect(controller.getState().messages.filter((row) => row.role === 'user')).toHaveLength(1);
    sessions.emitEvent('s1', { type: 'step_finish', part: { reason: 'completed' } }, { sequence: 50 });
    sessions.emitRunStarted({ id: 's1', clientMessageId: 'other', prompt: 'same prompt', startedAt: 20 });
    sessions.emitRunStarted({ id: 's1', clientMessageId: 'other', prompt: 'same prompt', startedAt: 20 });
    sessions.emitEvent('s1', { type: 'text', part: { text: 'fresh' } }, { sequence: 1 });
    expect(controller.getState().messages.filter((row) => row.role === 'user')).toHaveLength(2);
    expect(controller.getState().messages.at(-1)?.text).toBe('fresh');
  });

  it('tracks owned queue state, then transitions to answering on start', async () => {
    const sessions = fakeSessions();
    sessions.send.mockResolvedValue({ ok: true, queued: true });
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    controller.setDraft('queued');
    await controller.send();
    const id = sessions.send.mock.calls[0][0].clientMessageId;
    sessions.emitQueueState({ id: 's1', queuedCount: 1, queuedItems: [{ id, text: 'queued' }] });
    expect(controller.getState()).toMatchObject({ queuedCount: 1, status: '已排队', sending: false });
    sessions.emitRunStarted({ id: 's1', clientMessageId: id, startedAt: 10, prompt: 'queued' });
    sessions.emitQueueState({ id: 's1', queuedCount: 0, queuedItems: [] });
    expect(controller.getState()).toMatchObject({ queuedCount: 0, status: '正在回答…', running: true });
  });

  it('does not duplicate run-started notifications buffered alongside the same running snapshot', async () => {
    const sessions = fakeSessions();
    sessions.history.mockResolvedValue([{ role: 'user', text: 'question' }]);
    sessions.isRunning.mockResolvedValue({
      running: true,
      prompt: 'question',
      startedAt: 10,
      events: [
        { sequence: 1, event: { type: 'step_start', turnId: 't1' } },
        { sequence: 2, event: { type: 'text', part: { text: 'answer' } } },
      ],
    });
    const controller = createNotebookChat({ sessions });
    const selecting = controller.select('s1');
    sessions.emitRunStarted({ id: 's1', prompt: 'question', clientMessageId: 'cross-page', startedAt: 10 });
    sessions.emitEvent('s1', { type: 'text', part: { text: 'answer' } }, { sequence: 2 });
    await selecting;
    expect(controller.getState().messages.map((row) => row.text)).toEqual(['question', 'answer']);
  });

  it('does not revive completed output on duplicate sequenced step_start', async () => {
    const sessions = fakeSessions();
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    sessions.emitEvent('s1', { type: 'step_start', turnId: 't1' }, { sequence: 1 });
    sessions.emitEvent('s1', { type: 'text', part: { text: 'answer' } }, { sequence: 2 });
    sessions.emitEvent('s1', { type: 'step_finish', part: { reason: 'completed' } }, { sequence: 3 });
    sessions.emitEvent('s1', { type: 'step_start', turnId: 't1' }, { sequence: 1 });
    sessions.emitEvent('s1', { type: 'text', part: { text: 'answer' } }, { sequence: 2 });
    expect(controller.getState().running).toBe(false);
    expect(controller.getState().messages.map((row) => row.text)).toEqual(['answer']);
  });

  it('does not let an in-flight refresh revive a queue-rejected optimistic turn', async () => {
    const sessions = fakeSessions();
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    controller.setDraft('rejected');
    await controller.send();
    const id = sessions.send.mock.calls[0][0].clientMessageId;
    const history = deferred<Array<{ role: string; text: string }>>();
    sessions.history.mockReturnValueOnce(history.promise);
    sessions.isRunning.mockResolvedValueOnce({ running: true, events: [], prompt: 'rejected' });
    const refresh = controller.refresh();
    sessions.emitQueueError({ id: 's1', clientMessageId: id, error: 'busy' });
    history.resolve([]);
    await refresh;
    expect(controller.getState()).toMatchObject({
      running: false,
      sending: false,
      stopping: false,
      messages: [],
      draft: 'rejected',
    });
  });

  it('retains edited drafts and exit errors through automatic and manual refresh', async () => {
    const sessions = fakeSessions();
    const controller = createNotebookChat({ sessions });
    await controller.select('s1');
    controller.setDraft('draft survives');
    sessions.emitExit({ id: 's1', error: 'provider failed', exitCode: 1 });
    await settle();
    await controller.refresh();
    expect(controller.getState()).toMatchObject({
      draft: 'draft survives',
      error: 'provider failed',
      status: '运行出错',
      running: false,
    });
    sessions.history.mockRejectedValueOnce(new Error('history also offline'));
    await controller.refresh();
    expect(controller.getState().error).toBe('provider failed');
  });

  it('unsubscribes on dispose and never notifies afterwards', async () => {
    const sessions = fakeSessions();
    const changes: unknown[] = [];
    const controller = createNotebookChat({ sessions, onChange: (state) => changes.push(state) });
    controller.dispose();
    const count = changes.length;
    sessions.emitEvent('s1', { type: 'text', part: { text: 'late' } });
    controller.setDraft('ignored');
    await controller.select('s1');
    expect(changes).toHaveLength(count);
    expect(sessions.onEvent).toHaveBeenCalled();
    expect(sessions.unsubscriptions.every((unsubscribe) => unsubscribe.mock.calls.length === 1)).toBe(true);
  });
});
