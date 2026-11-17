const MAX_CACHE = 8;
const REMOTE_STATUS = '会话正在其他进程运行，无法从此处停止';

/**
 * @typedef {{id: string, role: string, text: string, streaming?: boolean,
 *   attemptId?: string, attemptLength?: number}} ChatMessage
 * @typedef {{sessionId: string, messages: ChatMessage[], draft: string,
 *   running: boolean, remoteRunning: boolean, loading: boolean, sending: boolean,
 *   stopping: boolean, queuedCount: number, queuedItems: Array<Record<string, unknown>>,
 *   error: string, status: string}} ChatState
 */

const EMPTY_STATE = {
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
};

function textOf(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function errorText(cause, fallback) {
  return textOf(cause?.message || cause || fallback);
}

function promptKey(value) {
  return textOf(value).replace(/\s+/g, ' ').trim();
}

/** @param {ChatState} state @returns {ChatState} */
function copyState(state) {
  return {
    ...state,
    messages: state.messages.map((message) => ({ ...message })),
    queuedItems: state.queuedItems.map((item) => ({ ...item })),
  };
}

function historyRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && (row.role === 'user' || row.role === 'assistant'))
    .map((row, index) => ({ id: row.id || `history-${index}`, role: row.role, text: textOf(row.text) }))
    .filter((row) => row.text);
}

function promptIndex(messages, prompt) {
  const key = promptKey(prompt);
  return key ? messages.findLastIndex((message) => message.role === 'user' && promptKey(message.text) === key) : -1;
}

function eventRecord(event, payload) {
  const value = payload?.sequence ?? event?.sequence;
  const sequence = value == null ? NaN : Number(value);
  return { sequence: Number.isFinite(sequence) ? sequence : null, event: payload?.event || event || null };
}

function finishMessages(messages) {
  return messages
    .filter((message) => message.role !== 'assistant' || message.text)
    .map((message) => (message.streaming ? { ...message, streaming: false } : message));
}

function applyEvent(messages, event, ids) {
  if (event?.type === 'text') {
    const delta = textOf(event.part?.text ?? event.text);
    if (!delta) return messages;
    const index = messages.findLastIndex((message) => message.role === 'assistant' && message.streaming);
    const attempt = event.attemptId == null ? {} : { attemptId: event.attemptId };
    if (index < 0)
      return [
        ...messages,
        {
          id: ids(),
          role: 'assistant',
          text: delta,
          streaming: true,
          ...attempt,
          ...(event.attemptId == null ? {} : { attemptLength: delta.length }),
        },
      ];
    return messages.map((message, current) =>
      current === index
        ? {
            ...message,
            text: `${message.text}${delta}`,
            ...attempt,
            ...(event.attemptId == null
              ? {}
              : {
                  attemptLength:
                    (message.attemptId === event.attemptId ? message.attemptLength || 0 : 0) + delta.length,
                }),
          }
        : message,
    );
  }
  if (event?.type === 'text_rollback') {
    const index = messages.findLastIndex((message) => message.role === 'assistant' && message.streaming);
    if (index < 0) return messages;
    const message = messages[index];
    // A late rollback from a failed provider attempt must not erase its successor.
    if (event.attemptId !== message.attemptId) return messages;
    const length = Math.min(Math.max(0, Number(event.length) || 0), message.attemptLength ?? message.text.length);
    return messages.map((row, current) =>
      current === index
        ? {
            ...row,
            text: row.text.slice(0, row.text.length - length),
            ...(row.attemptLength == null ? {} : { attemptLength: row.attemptLength - length }),
          }
        : row,
    );
  }
  return messages;
}

/** @param {{sessions?: any, onChange?: (state: ChatState) => void}} [options] */
export function createNotebookChat({ sessions, onChange } = {}) {
  let state = { ...EMPTY_STATE, messages: [], queuedItems: [] };
  const cache = new Map();
  const subscriptions = [];
  let generation = 0;
  let currentLoad = null;
  let disposed = false;
  let messageSequence = 0;

  const messageId = (prefix) => `${prefix}-${Date.now()}-${++messageSequence}`;
  const notify = () => {
    if (!disposed) onChange?.(copyState(state));
  };
  const active = (entry) => !disposed && cache.get(state.sessionId) === entry && entry.state === state;
  const remember = (id, entry) => {
    cache.delete(id);
    cache.set(id, entry);
    while (cache.size > MAX_CACHE) {
      const candidate = [...cache.entries()].find(
        ([key, value]) => key !== state.sessionId && !value.state.draft && !value.pending,
      );
      if (!candidate) break;
      cache.delete(candidate[0]);
    }
  };
  const currentEntry = () => cache.get(state.sessionId);
  const resetCursor = (entry, key) => {
    if (key && key !== entry.runKey) {
      entry.runKey = key;
      entry.lastSequence = -Infinity;
      entry.turnId = '';
    }
  };

  function processEvent(entry, record, { replay = false } = {}) {
    const target = entry.state;
    const event = record.event;
    if (!event) return;
    if (event.type === 'step_start' && event.turnId && event.turnId !== entry.turnId) {
      if (entry.turnId) entry.lastSequence = -Infinity;
      entry.turnId = event.turnId;
    }
    if (!replay && record.sequence != null && record.sequence <= entry.lastSequence) return;
    if (record.sequence != null) entry.lastSequence = Math.max(entry.lastSequence, record.sequence);
    if (event.type === 'step_start' || event.type === 'text' || event.type === 'retrying') {
      target.running = true;
      target.remoteRunning = false;
      target.status = event.type === 'retrying' ? '正在重试…' : '正在回答…';
      target.messages = applyEvent(target.messages, event, () => messageId('stream'));
    } else if (event.type === 'text_rollback') {
      target.messages = applyEvent(target.messages, event, () => messageId('stream'));
    } else if (event.type === 'error') {
      target.error = textOf(event.error?.data?.message || event.error?.message || event.error?.name || '这一轮失败了');
      target.status = '运行出错';
    } else if (event.type === 'step_finish') {
      // chat-events.js maps turn/completed to step_finish, then chat.js emits exit.
      target.running = false;
      target.sending = false;
      target.stopping = false;
      target.messages = finishMessages(target.messages);
      const reason = event.part?.reason;
      if (event.part?.error) target.error = textOf(event.part.error);
      if (reason === 'error' && !target.error) target.error = '这一轮失败了';
      target.status = reason === 'error' ? '运行出错' : reason === 'aborted' ? '已停止' : '';
      entry.pending = null;
    }
  }

  function runStarted(entry, payload) {
    const target = entry.state;
    const key = payload.startedAt ? `started:${payload.startedAt}` : payload.clientMessageId;
    const duplicate = Boolean(key && key === entry.startedKey);
    const pending = entry.pending;
    const own = pending && payload.clientMessageId === pending.id;
    if (duplicate) {
      if (own) pending.started = true;
      return;
    }
    resetCursor(entry, key);
    entry.startedKey = key || '';
    const existing =
      payload.clientMessageId && target.messages.some((message) => message.id === payload.clientMessageId);
    if (!own && !existing && !duplicate && payload.prompt) {
      target.messages = finishMessages(target.messages);
      target.messages.push({
        id: payload.clientMessageId || messageId('run'),
        role: 'user',
        text: textOf(payload.prompt),
      });
    }
    if (own) pending.started = true;
    target.running = true;
    target.remoteRunning = false;
    target.sending = false;
    target.status = '正在回答…';
  }

  function queueState(entry, payload) {
    const target = entry.state;
    target.queuedItems = Array.isArray(payload.queuedItems) ? payload.queuedItems.map((item) => ({ ...item })) : [];
    target.queuedCount = Math.max(0, Number(payload.queuedCount ?? target.queuedItems.length) || 0);
    const pending = entry.pending;
    if (pending && target.queuedItems.some((item) => item.id === pending.id || item.clientMessageId === pending.id)) {
      target.sending = false;
      target.status = '已排队';
    } else if (target.status === '已排队') {
      target.status = target.running ? '正在回答…' : '';
    }
  }

  function rejectPending(entry, pending, cause) {
    if (entry.pending !== pending) return;
    const target = entry.state;
    target.messages = target.messages.filter((message) => message.id !== pending.id && message.id !== pending.replyId);
    target.running = false;
    target.remoteRunning = false;
    target.sending = false;
    target.stopping = false;
    target.status = '发送失败';
    target.queuedItems = target.queuedItems.filter(
      (item) => item.id !== pending.id && item.clientMessageId !== pending.id,
    );
    target.queuedCount = target.queuedItems.length;
    const message = errorText(cause, '发送失败');
    target.error = message;
    if (!target.draft) target.draft = pending.prompt;
    else target.error = `${message}（原消息可恢复：${pending.prompt}）`;
    entry.pending = null;
    // Keep the original session's draft even if the user switched before start failed.
    remember(target.sessionId, entry);
    if (active(entry)) {
      // A status read begun before rejection can still say running. Its snapshot
      // cannot resurrect this now-retracted input or its empty reply placeholder.
      currentLoad = null;
      target.loading = false;
      notify();
    }
  }

  const acceptLiveEvent = (id, event, payload) => {
    if (disposed || id !== state.sessionId) return;
    const record = eventRecord(event, payload);
    if (currentLoad) currentLoad.actions.push({ kind: 'event', record });
    else {
      processEvent(currentEntry(), record);
      notify();
    }
  };
  const receive = (kind, payload) => {
    const id = payload?.sessionId || payload?.id;
    if (disposed || !id) return;
    const entry = cache.get(id);
    if (!entry) return;
    if (kind === 'queueError') {
      if (entry.pending && payload.clientMessageId === entry.pending.id)
        rejectPending(entry, entry.pending, payload.error || '消息发送失败');
      return;
    }
    if (!active(entry)) return;
    if (currentLoad) currentLoad.actions.push({ kind, payload });
    else {
      if (kind === 'started') runStarted(entry, payload);
      if (kind === 'queue') queueState(entry, payload);
      notify();
    }
  };

  const handleExit = (payload) => {
    const id = payload?.sessionId || payload?.id;
    if (disposed || id !== state.sessionId) return;
    const entry = currentEntry();
    const target = entry.state;
    target.running = false;
    target.remoteRunning = false;
    target.sending = false;
    target.stopping = false;
    target.messages = finishMessages(target.messages);
    entry.pending = null;
    const exitError = payload.error || (payload.exitCode ? `会话运行失败（退出码 ${payload.exitCode}）` : '');
    if (exitError) target.error = errorText(exitError, '运行出错');
    target.status = exitError || target.error ? '运行出错' : payload.aborted ? '已停止' : '';
    notify();
    void refresh();
  };

  if (sessions?.onEvent) subscriptions.push(sessions.onEvent(acceptLiveEvent));
  if (sessions?.onExit) subscriptions.push(sessions.onExit(handleExit));
  if (sessions?.onQueueError) subscriptions.push(sessions.onQueueError((payload) => receive('queueError', payload)));
  if (sessions?.onRunStarted) subscriptions.push(sessions.onRunStarted((payload) => receive('started', payload)));
  if (sessions?.onQueueState) subscriptions.push(sessions.onQueueState((payload) => receive('queue', payload)));

  async function load(entry) {
    if (!active(entry)) return;
    const id = state.sessionId;
    const loadState = { generation, actions: [] };
    // Superseding a refresh must not drop events already received during its read.
    if (currentLoad) loadState.actions.push(...currentLoad.actions);
    currentLoad = loadState;
    state.loading = !entry.loaded && !state.messages.length;
    if (state.loading) state.status = '正在读取…';
    notify();
    const [historyResult, statusResult] = await Promise.allSettled([
      Promise.resolve().then(() => sessions.history(id)),
      Promise.resolve().then(() => sessions.isRunning(id)),
    ]);
    if (!active(entry) || loadState.generation !== generation || currentLoad !== loadState) return;

    const historyOK = historyResult.status === 'fulfilled';
    const statusOK = statusResult.status === 'fulfilled';
    if (historyOK && statusOK && entry.readError && state.error === entry.readError) {
      state.error = '';
      entry.readError = '';
    }
    const status = statusOK ? statusResult.value || {} : {};
    const records = (Array.isArray(status.events) ? status.events : []).map((item) =>
      eventRecord(item?.event || item, item?.event ? item : null),
    );
    resetCursor(entry, status.startedAt ? `started:${status.startedAt}` : '');
    let messages = historyOK ? historyRows(historyResult.value) : state.messages;
    const boundary = promptIndex(messages, status.prompt);
    const durableReply =
      boundary >= 0 && messages.slice(boundary + 1).some((message) => message.role === 'assistant' && message.text);
    const replay = !status.remoteRunning && (status.running === true || status.finished === true) && records.length > 0;
    // Rebuild a running turn at its prompt boundary. Finished output already on disk
    // wins over the old event buffer; replay only fills a not-yet-persisted reply.
    const rebuild = historyOK && replay && (status.running === true || !durableReply);
    if (rebuild && boundary >= 0) messages = messages.slice(0, boundary + 1);
    if ((status.running || (status.finished && rebuild)) && status.prompt && boundary < 0) {
      messages = [...messages, { id: messageId('run'), role: 'user', text: textOf(status.prompt) }];
    }
    // Preserve an in-flight optimistic input not visible in the disk snapshot yet.
    if (entry.pending && promptIndex(messages, entry.pending.prompt) < 0) {
      messages = [
        ...messages,
        ...state.messages.filter((message) => message.id === entry.pending.id || message.id === entry.pending.replyId),
      ];
    }
    state.messages = messages;
    if (status.startedAt && (status.running || status.finished) && promptIndex(messages, status.prompt) >= 0) {
      entry.startedKey = `started:${status.startedAt}`;
    }
    if (statusOK) {
      state.remoteRunning = status.remoteRunning === true;
      state.running = status.running === true || state.remoteRunning || Boolean(entry.pending);
      queueState(entry, status);
      state.status = state.remoteRunning ? REMOTE_STATUS : state.running ? '正在回答…' : state.error ? '运行出错' : '';
    } else if (state.status === '正在读取…') state.status = '';
    if (rebuild) {
      for (const record of records) processEvent(entry, record, { replay: true });
    } else if (replay && !historyOK) {
      for (const record of records) processEvent(entry, record);
    } else {
      for (const record of records)
        if (record.sequence != null) entry.lastSequence = Math.max(entry.lastSequence, record.sequence);
    }
    if (statusOK && !status.running && !entry.pending) {
      // A finished replay can end in text if the host crashed before emitting
      // turn/completed. The snapshot's terminal state still closes that stream.
      state.running = state.remoteRunning;
      state.sending = false;
      state.stopping = false;
      if (status.exit?.error) state.error = errorText(status.exit.error, '运行出错');
      state.status = state.remoteRunning
        ? REMOTE_STATUS
        : state.error
          ? '运行出错'
          : state.status === '已停止'
            ? '已停止'
            : '';
    }
    // Snapshot status was read before these live notifications; never overwrite them.
    for (const action of loadState.actions) {
      if (action.kind === 'event') processEvent(entry, action.record);
      if (action.kind === 'started') runStarted(entry, action.payload);
      if (action.kind === 'queue') queueState(entry, action.payload);
    }
    currentLoad = null;
    state.loading = false;
    if (!state.running) state.messages = finishMessages(state.messages);
    if (historyOK) entry.loaded = true;
    const failure = [historyResult, statusResult].find((result) => result.status === 'rejected');
    if (failure && !state.error) {
      state.error = errorText(failure.reason, '读取会话失败');
      entry.readError = state.error;
    }
    notify();
  }

  async function select(sessionId, cwd) {
    if (disposed) return;
    generation += 1;
    currentLoad = null;
    const id = textOf(sessionId);
    if (!id) {
      state = { ...EMPTY_STATE, messages: [], queuedItems: [] };
      notify();
      return;
    }
    const entry = cache.get(id) || {
      state: { ...EMPTY_STATE, sessionId: id, messages: [], queuedItems: [] },
      cwd: null,
      loaded: false,
      lastSequence: -Infinity,
      runKey: '',
      turnId: '',
      startedKey: '',
      pending: null,
    };
    if (cwd !== undefined) entry.cwd = cwd || null;
    remember(id, entry);
    state = entry.state;
    notify();
    await load(entry);
  }

  async function refresh() {
    if (!disposed && state.sessionId) await load(currentEntry());
  }

  function setDraft(text) {
    if (disposed) return;
    state.draft = textOf(text);
    notify();
  }

  async function send() {
    if (
      disposed ||
      state.running ||
      state.loading ||
      currentLoad ||
      state.remoteRunning ||
      state.sending ||
      !state.sessionId ||
      !state.draft.trim()
    )
      return null;
    const entry = currentEntry();
    const target = entry.state;
    const pending = { id: messageId('sent'), replyId: messageId('reply'), prompt: state.draft, started: false };
    entry.pending = pending;
    // A newly spawned host can start its sequence at 1 again.
    entry.lastSequence = -Infinity;
    entry.turnId = '';
    target.draft = '';
    target.error = '';
    target.running = true;
    target.sending = true;
    target.status = '正在发送…';
    target.messages = [
      ...finishMessages(target.messages),
      { id: pending.id, role: 'user', text: pending.prompt },
      { id: pending.replyId, role: 'assistant', text: '', streaming: true },
    ];
    notify();
    try {
      const result = await sessions.send({
        sessionId: target.sessionId,
        cwd: entry.cwd,
        prompt: pending.prompt,
        clientMessageId: pending.id,
      });
      if (disposed) return result;
      if (result?.ok === false) throw new Error(result.error || '发送失败');
      // A queue-error or exit can arrive before start() resolves successfully.
      if (entry.pending !== pending) return result;
      target.sending = false;
      target.status = result?.queued && !pending.started ? '已排队' : '正在回答…';
      if (active(entry)) notify();
      return result;
    } catch (cause) {
      if (!disposed) rejectPending(entry, pending, cause);
      return null;
    }
  }

  async function stop() {
    if (disposed || !state.sessionId || !state.running || state.remoteRunning || state.stopping) return null;
    const entry = currentEntry();
    const target = entry.state;
    target.stopping = true;
    target.status = '正在停止…';
    notify();
    try {
      const result = await sessions.abort(target.sessionId);
      if (result?.ok === false) throw new Error(result.error || '停止失败');
      // Abort acknowledgement is not turn completion. Wait for step_finish/exit.
      return result;
    } catch (cause) {
      if (disposed) return null;
      target.stopping = false;
      target.error = errorText(cause, '停止失败');
      target.status = target.running ? '正在回答…' : '';
      if (active(entry)) notify();
      return null;
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    currentLoad = null;
    for (const unsubscribe of subscriptions.splice(0)) {
      try {
        unsubscribe?.();
      } catch {
        /* An already-disposed IPC subscription is harmless. */
      }
    }
    cache.clear();
  }

  return { getState: () => copyState(state), select, setDraft, refresh, send, stop, dispose };
}
