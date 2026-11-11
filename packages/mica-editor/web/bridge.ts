import { MARKDOWN_CHANNEL, type MarkdownDocument, type MarkdownHostMessage } from '../protocol.js';

export type MarkdownEditorStatus = 'loading' | 'ready' | 'fallback';
export const MARKDOWN_TIMEOUT_MS = 15_000;

type Request = {
  documentId: string;
  generation: number;
  type: 'load' | 'flush';
  resolve(value: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** Pure host-side bridge. The iframe owns Lexical; the host only owns Markdown strings. */
export function createMarkdownBridge(options: {
  token: string;
  target(): Window | null;
  onChange(documentId: string, value: string): void;
  onStatus(status: MarkdownEditorStatus, message?: string): void;
  onReady?(): void;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? MARKDOWN_TIMEOUT_MS;
  const requests = new Map<string, Request>();
  let current: MarkdownDocument | null = null;
  let propValue = '';
  let echoes: string[] = [];
  let generation = 0;
  let sequence = 0;
  let ready = false;
  let loaded = false;
  let fallback = false;
  let disposed = false;
  let loading: Promise<string> | null = null;
  const bootTimer = setTimeout(() => fail('编辑器加载超时，已保留 Markdown 源码。'), timeoutMs);

  function post(message: MarkdownHostMessage) {
    options.target()?.postMessage({ channel: MARKDOWN_CHANNEL, token: options.token, ...message }, '*');
  }

  function rejectRequests(message: string) {
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    requests.clear();
  }

  function fail(message: string) {
    if (disposed || fallback) return;
    fallback = true;
    loaded = false;
    clearTimeout(bootTimer);
    rejectRequests(message);
    options.onStatus('fallback', message);
  }

  function request(type: 'load' | 'flush'): Promise<string> {
    if (!current) return Promise.reject(new Error('尚未选择 Markdown 文档。'));
    const documentId = current.documentId;
    const requestId = `${++sequence}`;
    return new Promise((resolve, reject) => {
      requests.set(requestId, {
        documentId, generation, type, resolve, reject,
        timer: setTimeout(() => fail('编辑器未响应，已保留最后收到的 Markdown 源码。'), timeoutMs),
      });
      try {
        if (type === 'load') post({ type, requestId, ...current! });
        else post({ type, requestId });
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    });
  }

  function load() {
    if (!ready || fallback || disposed || !current) return;
    loaded = false;
    options.onStatus('loading');
    loading = request('load');
    // A load may happen without a caller waiting for flush(). Report via onStatus, never unhandled.
    void loading.catch(() => undefined);
  }

  function setDocument(next: MarkdownDocument) {
    if (disposed) return;
    const sameDocument = current?.documentId === next.documentId;
    const echoIndex = echoes.indexOf(next.value);
    const echo = sameDocument && (next.value === current!.value || next.value === propValue || echoIndex !== -1);
    propValue = next.value;
    if (echo) {
      if (echoIndex !== -1) echoes.splice(0, echoIndex + 1);
      if (current!.readOnly !== next.readOnly) {
        current!.readOnly = next.readOnly;
        if (ready && !fallback) post({ type: 'editable', readOnly: next.readOnly });
      }
      return;
    }
    generation += 1;
    echoes = [];
    rejectRequests('Markdown 文档已切换，请重试。');
    loading = null;
    current = { ...next };
    loaded = false;
    if (!fallback) load();
  }

  function accept(value: string) {
    if (!current || current.readOnly || value === current.value) return;
    current.value = value;
    echoes.push(value);
    // Synchronous: flush() must register the autosave before its promise resolves.
    options.onChange(current.documentId, value);
  }

  function receive(event: MessageEvent) {
    const data = event.data;
    const target = options.target();
    if (disposed || fallback || !target || event.source !== target || !data ||
      data.channel !== MARKDOWN_CHANNEL || data.token !== options.token) return;
    if (data.type === 'ready') {
      if (ready) return;
      ready = true;
      clearTimeout(bootTimer);
      options.onReady?.();
      load();
      return;
    }
    if (data.type === 'error') {
      if (data.requestId !== undefined && !requests.has(data.requestId)) return;
      fail(typeof data.message === 'string' ? data.message : '编辑器加载失败。');
      return;
    }
    if (!current || data.documentId !== current.documentId) return;
    if (data.type === 'change') {
      if (loaded && typeof data.value === 'string') accept(data.value);
      return;
    }
    if (data.type !== 'loaded' && data.type !== 'result') return;
    const pending = requests.get(data.requestId);
    if (!pending || pending.documentId !== current.documentId || pending.generation !== generation ||
      (data.type === 'loaded' ? pending.type !== 'load' : pending.type !== 'flush')) return;
    if (data.type === 'result' && typeof data.value !== 'string') return;
    clearTimeout(pending.timer);
    requests.delete(data.requestId);
    if (data.type === 'loaded') {
      loaded = true;
      options.onStatus('ready');
    } else {
      accept(data.value);
    }
    pending.resolve(current.value);
  }

  async function flush(): Promise<string> {
    if (disposed) throw new Error('Markdown 编辑器已关闭。');
    if (!current) return '';
    if (fallback) return current.value;
    const expectedGeneration = generation;
    if (!ready) {
      // Boot can still be in flight. Waiting is event-driven and shares the boot timeout.
      await new Promise<void>((resolve, reject) => {
        const requestId = `boot-${++sequence}`;
        requests.set(requestId, {
          documentId: current!.documentId, generation, type: 'load',
          resolve: () => resolve(), reject,
          timer: setTimeout(() => fail('编辑器加载超时，已保留 Markdown 源码。'), timeoutMs),
        });
      });
    }
    if (loading) await loading;
    if (generation !== expectedGeneration) throw new Error('Markdown 文档已切换，请重试。');
    return request('flush');
  }

  return {
    setDocument,
    receive(event: MessageEvent) {
      receive(event);
      // Boot waiters resume only after a genuine loaded acknowledgement.
      if (!loaded || !current) return;
      for (const [id, pending] of requests) {
        if (!id.startsWith('boot-') || pending.generation !== generation) continue;
        clearTimeout(pending.timer);
        requests.delete(id);
        pending.resolve(current.value);
      }
    },
    flush,
    fail,
    editSource: accept,
    getValue: () => current?.value ?? '',
    theme(appearance: string, tokens: Record<string, string>) {
      if (ready && !fallback) post({ type: 'theme', appearance, tokens });
    },
    dispose() {
      disposed = true;
      clearTimeout(bootTimer);
      rejectRequests('Markdown 编辑器已关闭。');
    },
  };
}
