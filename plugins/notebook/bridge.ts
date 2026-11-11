import { parseNotebookDocument } from './model';
import type { NotebookDocument } from './model';

export const NOTEBOOK_CHANNEL = 'mica-notebook';

export interface NotebookOutline {
  items: { key: string; text: string; level: number }[];
  activeKey: string | null;
  blocks: { table: boolean; code: boolean; mermaid: boolean; image: boolean };
}

/** 只接受本插件 iframe + 随机 token 的消息，不把宿主 API 注入第三方运行时。 */
export function createEditorBridge(options: {
  token: string;
  target: () => Window | null;
  onReady: () => void;
  onChange: (noteId: string, value: NotebookDocument) => void;
  onError: (message: string) => void;
  onLoaded?: (noteId: string) => void;
  onOutline?: (noteId: string, outline: NotebookOutline) => void;
}) {
  let disposed = false;
  let ready = false;
  let sequence = 0;
  let active: { noteId: string; loadId: string; loaded: boolean } | null = null;
  const pending = new Map<
    string,
    {
      type: 'load' | 'flush';
      noteId: string;
      loadId: string;
      document?: NotebookDocument;
      resolve: (value: { noteId: string; document: NotebookDocument }) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  function send(type: string, payload: Record<string, unknown> = {}) {
    if (disposed) return;
    options.target()?.postMessage({ channel: NOTEBOOK_CHANNEL, token: options.token, type, ...payload }, '*');
  }
  function rejectRequests(message: string) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    pending.clear();
  }
  function request(type: 'load' | 'flush', document?: NotebookDocument) {
    if (disposed) return Promise.reject(new Error('编辑器已关闭'));
    if (!options.target()) return Promise.reject(new Error('编辑器尚未就绪'));
    if (!active || (type === 'flush' && !active.loaded)) return Promise.reject(new Error('笔记尚未完成加载，请重试'));
    const { noteId, loadId } = active;
    const requestId = type === 'load' ? loadId : `flush-${++sequence}`;
    return new Promise<{ noteId: string; document: NotebookDocument }>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(type === 'load' ? '笔记未能完成加载，请重试' : '编辑器没有响应，当前草稿已保留。请先导出备份再重试。'));
      }, type === 'load' ? 10000 : 5000);
      pending.set(requestId, { type, noteId, loadId, document, resolve, reject, timer });
      try {
        send(type, { requestId, noteId, loadId, ...(type === 'load' ? { document } : {}) });
      } catch (cause) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }
  function receive(event: MessageEvent) {
    const target = options.target();
    if (disposed || !target || event.source !== target) return;
    const data = event.data;
    if (!data || data.channel !== NOTEBOOK_CHANNEL || data.token !== options.token) return;
    if (data.type === 'outline') {
      if (
        !active?.loaded || data.noteId !== active.noteId || data.loadId !== active.loadId ||
        !Array.isArray(data.items) ||
        !data.items.every(
          (item: NotebookOutline['items'][number]) =>
            item &&
            typeof item.key === 'string' &&
            typeof item.text === 'string' &&
            Number.isInteger(item.level) &&
            item.level >= 1 &&
            item.level <= 6,
        ) ||
        !data.blocks ||
        !['table', 'code', 'mermaid', 'image'].every((key) => typeof data.blocks[key] === 'boolean') ||
        (data.activeKey !== null &&
          (typeof data.activeKey !== 'string' ||
            !data.items.some((item: NotebookOutline['items'][number]) => item.key === data.activeKey)))
      )
        return;
      options.onOutline?.(data.noteId, { items: data.items, activeKey: data.activeKey, blocks: data.blocks });
      return;
    }
    if (data.type === 'ready') {
      if (ready) return;
      ready = true;
      options.onReady();
      return;
    }
    if (data.type === 'error') {
      const message = typeof data.message === 'string' ? data.message : '编辑器操作失败';
      const request = pending.get(data.requestId);
      if (request) {
        if (data.loadId !== request.loadId) return;
        clearTimeout(request.timer);
        request.reject(new Error(message));
        pending.delete(data.requestId);
      } else if ((data.requestId !== undefined && data.requestId !== active?.loadId) ||
        (data.loadId !== undefined && data.loadId !== active?.loadId)) {
        return;
      }
      options.onError(message);
      return;
    }
    if (data.type === 'loaded') {
      const load = pending.get(data.requestId);
      if (!load || load.type !== 'load' || !active ||
        data.noteId !== load.noteId || data.loadId !== load.loadId || active.loadId !== load.loadId) return;
      clearTimeout(load.timer);
      pending.delete(data.requestId);
      active.loaded = true;
      load.resolve({ noteId: load.noteId, document: load.document! });
      options.onLoaded?.(data.noteId);
      return;
    }
    if (data.type !== 'change' && data.type !== 'result') return;
    if (!active?.loaded || data.noteId !== active.noteId || data.loadId !== active.loadId) return;
    const result = data.type === 'result' ? pending.get(data.requestId) : undefined;
    if (data.type === 'result' && (!result || result.type !== 'flush' || result.loadId !== active.loadId)) return;
    try {
      if (typeof data.noteId !== 'string') throw new Error('编辑器未返回笔记身份');
      // 超限草稿仍保留在宿主内存供导出；保存层负责硬限制，不能丢弃最后一次输入。
      let document: NotebookDocument;
      try {
        document = parseNotebookDocument(data.document);
      } catch (error) {
        if (
          !error ||
          !String(error).includes('exceeds') ||
          data.document?.version !== 1 ||
          typeof data.document.editorState !== 'string'
        )
          throw error;
        document = structuredClone(data.document) as NotebookDocument;
        options.onError('这篇笔记超过 6 MiB 保存上限。最新草稿已保留，请减少内嵌图片或先下载草稿备份。');
      }
      if (data.type === 'change') options.onChange(data.noteId, document);
      else {
        clearTimeout(result!.timer);
        pending.delete(data.requestId);
        result!.resolve({ noteId: data.noteId, document });
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (result) {
        clearTimeout(result.timer);
        pending.delete(data.requestId);
        result.reject(error);
      }
      options.onError(error.message);
    }
  }
  return {
    receive,
    load(noteId: string, document: NotebookDocument): Promise<void> {
      rejectRequests('笔记已切换，请重试');
      active = { noteId, loadId: `load-${++sequence}`, loaded: false };
      return request('load', document).then(() => undefined);
    },
    freeze(frozen: boolean) {
      send('freeze', { frozen });
    },
    /** 顶栏两侧在宿主里占的宽度：编辑器把同一行工具栏的左右两端让出来。 */
    layout(insets: { left: number; right: number; height: number }) {
      send('layout', insets);
    },
    theme(appearance: string, tokens: Record<string, string>) {
      send('theme', { appearance, tokens });
    },
    navigate(noteId: string, target: { heading?: string; block?: 'top' | keyof NotebookOutline['blocks'] }) {
      if (active?.loaded && active.noteId === noteId) send('navigate', { noteId, loadId: active.loadId, ...target });
    },
    action(noteId: string, action: 'style' | 'present') {
      if (active?.loaded && active.noteId === noteId) send('action', { noteId, loadId: active.loadId, action });
    },
    flush(): Promise<{ noteId: string; document: NotebookDocument }> {
      return request('flush');
    },
    dispose() {
      disposed = true;
      active = null;
      rejectRequests('编辑器已关闭');
    },
  };
}
