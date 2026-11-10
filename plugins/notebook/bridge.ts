import { parseNotebookDocument } from './model';
import type { NotebookDocument } from './model';

export const NOTEBOOK_CHANNEL = 'mica-notebook';

/** 只接受本插件 iframe + 随机 token 的消息，不把宿主 API 注入第三方运行时。 */
export function createEditorBridge(options: {
  token: string;
  target: () => Window | null;
  onReady: () => void;
  onChange: (noteId: string, value: NotebookDocument) => void;
  onError: (message: string) => void;
  onLoaded?: (noteId: string) => void;
}) {
  let disposed = false;
  let sequence = 0;
  const pending = new Map<string, {
    resolve: (value: { noteId: string; document: NotebookDocument }) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const loads = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  function send(type: string, payload: Record<string, unknown> = {}) {
    if (disposed) return;
    options.target()?.postMessage({ channel: NOTEBOOK_CHANNEL, token: options.token, type, ...payload }, '*');
  }
  function receive(event: MessageEvent) {
    if (disposed || event.source !== options.target()) return;
    const data = event.data;
    if (!data || data.channel !== NOTEBOOK_CHANNEL || data.token !== options.token) return;
    if (data.type === 'ready') { options.onReady(); return; }
    if (data.type === 'error') {
      const message = typeof data.message === 'string' ? data.message : '编辑器操作失败';
      const request = pending.get(data.requestId);
      if (request) { clearTimeout(request.timer); request.reject(new Error(message)); pending.delete(data.requestId); }
      const load = loads.get(data.noteId);
      if (load) { clearTimeout(load.timer); load.reject(new Error(message)); loads.delete(data.noteId); }
      options.onError(message);
      return;
    }
    if (data.type === 'loaded') {
      const load = loads.get(data.noteId);
      if (load) { clearTimeout(load.timer); load.resolve(); loads.delete(data.noteId); }
      options.onLoaded?.(data.noteId);
      return;
    }
    if (data.type !== 'change' && data.type !== 'result') return;
    try {
      if (typeof data.noteId !== 'string') throw new Error('编辑器未返回笔记身份');
      // 超限草稿仍保留在宿主内存供导出；保存层负责硬限制，不能丢弃最后一次输入。
      let document: NotebookDocument;
      try { document = parseNotebookDocument(data.document); }
      catch (error) {
        if (!error || !String(error).includes('exceeds') || data.document?.version !== 1 || typeof data.document.editorState !== 'string' || !Array.isArray(data.document.comments)) throw error;
        document = structuredClone(data.document) as NotebookDocument;
        options.onError('这篇笔记超过 6 MiB 保存上限。最新草稿已保留，请减少内嵌图片或先下载草稿备份。');
      }
      if (data.type === 'change') options.onChange(data.noteId, document);
      else {
        const request = pending.get(data.requestId);
        if (!request) return;
        clearTimeout(request.timer);
        pending.delete(data.requestId);
        request.resolve({ noteId: data.noteId, document });
      }
    } catch (cause) { options.onError(cause instanceof Error ? cause.message : String(cause)); }
  }
  return {
    receive,
    load(noteId: string, document: NotebookDocument): Promise<void> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { loads.delete(noteId); reject(new Error('笔记未能完成加载，请重试')); }, 10000);
        loads.set(noteId, { resolve, reject, timer });
        send('load', { noteId, document });
      });
    },
    freeze(frozen: boolean) { send('freeze', { frozen }); },
    theme(appearance: string, tokens: Record<string, string>) { send('theme', { appearance, tokens }); },
    flush(): Promise<{ noteId: string; document: NotebookDocument }> {
      const requestId = `flush-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error('编辑器没有响应，当前草稿已保留。请先导出备份再重试。'));
        }, 5000);
        pending.set(requestId, { resolve, reject, timer });
        send('flush', { requestId });
      });
    },
    dispose() {
      disposed = true;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('编辑器已关闭')); }
      pending.clear();
      for (const load of loads.values()) { clearTimeout(load.timer); load.reject(new Error('编辑器已关闭')); }
      loads.clear();
    }
  };
}
