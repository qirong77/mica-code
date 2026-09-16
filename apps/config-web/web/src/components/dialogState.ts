/**
 * 应用内对话框（prompt / confirm）的请求队列，供 DialogHost 渲染。
 *
 * 配置页不能依赖 window.prompt / window.confirm：桌面端把配置页以跨源 iframe
 * 内嵌（apps/desktop 的 SettingsView），而 Electron 不支持 prompt()
 * ——顶层抛 "prompt() is not supported."，跨源 iframe 里静默返回 null——这正是
 * 「点新建没反应」的原因；confirm() 也会在窗口未激活时静默返回 false，跨源
 * iframe 里的 JS 弹窗在现代 Chromium（92+）中同样被禁止。
 * 逻辑与渲染分离，队列语义可以在 node 环境下单测。
 */

export type ConfirmDialogOptions = {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};

export type PromptDialogOptions = {
  title: string;
  message?: string;
  label?: string;
  placeholder?: string;
  initialValue?: string;
  confirmText?: string;
  cancelText?: string;
};

export type DialogRequest =
  | ({ kind: 'confirm'; id: number } & ConfirmDialogOptions)
  | ({ kind: 'prompt'; id: number } & PromptDialogOptions);

export type ConfirmDialogRequest = Extract<DialogRequest, { kind: 'confirm' }>;
export type PromptDialogRequest = Extract<DialogRequest, { kind: 'prompt' }>;

export type DialogStore = {
  subscribe(listener: () => void): () => void;
  /** 当前待处理的请求（引用稳定，可直接喂给 useSyncExternalStore）。 */
  getSnapshot(): DialogRequest | null;
  confirm(options: ConfirmDialogOptions): Promise<boolean>;
  prompt(options: PromptDialogOptions): Promise<string | null>;
  /** accept=false 一律按取消处理；prompt 取消时返回 null。 */
  settle(accept: boolean, value?: string): void;
};

type PendingDialog = {
  request: DialogRequest;
  resolve(result: boolean | string | null): void;
};

export function createDialogStore(): DialogStore {
  let nextId = 0;
  let current: PendingDialog | null = null;
  const queue: PendingDialog[] = [];
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function advance(): void {
    current = queue.shift() ?? null;
    emit();
  }

  function enqueue(request: DialogRequest): Promise<boolean | string | null> {
    return new Promise((resolve) => {
      const pending: PendingDialog = { request, resolve };
      if (current) queue.push(pending);
      else {
        current = pending;
        emit();
      }
    });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => current?.request ?? null,
    confirm: (options) => enqueue({ kind: 'confirm', id: ++nextId, ...options }) as Promise<boolean>,
    prompt: (options) => enqueue({ kind: 'prompt', id: ++nextId, ...options }) as Promise<string | null>,
    settle(accept, value) {
      const pending = current;
      if (!pending) return;
      const result = pending.request.kind === 'confirm' ? accept : accept ? (value ?? '') : null;
      // 先出队再 settle：调用方拿到结果后可能立刻开下一个对话框。
      advance();
      pending.resolve(result);
    },
  };
}
