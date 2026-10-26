import type { Disposable } from '@packages/mica-common/index.js';
import type { GuardHookResult, HookHandler, HookOptions } from './HookTypes.js';

type HookRegistration = {
  handler: HookHandler;
  options: Required<Pick<HookOptions, 'priority' | 'failPolicy'>> & Omit<HookOptions, 'priority' | 'failPolicy'>;
  order: number;
};

export class HookRegistry {
  private order = 0;
  private readonly hooks = new Map<string, HookRegistration[]>();
  private handlerErrorReporter: ((error: unknown, hook: string, pluginId?: string) => void) | null = null;

  /**
   * 装上「hook 处理函数抛错」的观察者。
   *
   * 默认 `failPolicy: 'continue'` 会吞掉异常——这是对的（一个插件的钩子不该打断整个
   * turn），但完全无声就成了排查黑洞：某个插件的钩子每轮都炸，用户只会觉得「功能没反应」。
   * 由宿主接到插件日志与健康上报上。
   */
  setHandlerErrorReporter(reporter: (error: unknown, hook: string, pluginId?: string) => void): void {
    this.handlerErrorReporter = reporter;
  }

  on<TEvent = unknown, TResult = unknown>(
    name: string,
    handler: HookHandler<TEvent, TResult>,
    options: HookOptions = {},
  ): Disposable {
    const registrations = this.hooks.get(name) ?? [];
    const registration: HookRegistration = {
      handler: handler as HookHandler,
      options: {
        pluginId: options.pluginId,
        priority: options.priority ?? 0,
        failPolicy: options.failPolicy ?? 'continue',
      },
      order: this.order++,
    };

    registrations.push(registration);
    registrations.sort((a, b) => a.options.priority - b.options.priority || a.order - b.order);
    this.hooks.set(name, registrations);

    return {
      dispose: () => {
        const current = this.hooks.get(name);
        if (!current) return;
        const index = current.indexOf(registration);
        if (index >= 0) current.splice(index, 1);
      },
    };
  }

  async emit<TEvent>(name: string, event: TEvent): Promise<void> {
    for (const registration of this.hooks.get(name) ?? []) {
      await this.runHandler(name, registration, event);
    }
  }

  async pipeline<TEvent>(name: string, event: TEvent): Promise<TEvent> {
    let current = event;
    for (const registration of this.hooks.get(name) ?? []) {
      const result = await this.runHandler<TEvent, TEvent | { event?: TEvent }>(name, registration, current);
      if (result && typeof result === 'object' && 'event' in result && result.event) {
        current = result.event;
      } else if (result !== undefined) {
        current = result as TEvent;
      }
    }
    return current;
  }

  pipelineSync<TEvent>(name: string, event: TEvent): TEvent {
    let current = event;
    for (const registration of this.hooks.get(name) ?? []) {
      const result = this.runHandlerSync<TEvent, TEvent | { event?: TEvent }>(name, registration, current);
      if (result && typeof result === 'object' && 'event' in result && result.event) {
        current = result.event;
      } else if (result !== undefined) {
        current = result as TEvent;
      }
    }
    return current;
  }

  async guard<TEvent>(
    name: string,
    event: TEvent,
  ): Promise<{ event: TEvent; handled: boolean; blocked: boolean; reason?: string }> {
    let current = event;
    for (const registration of this.hooks.get(name) ?? []) {
      const result = await this.runHandler<TEvent, GuardHookResult<TEvent>>(name, registration, current);
      if (!result) continue;
      if (result.action === 'continue') {
        current = result.event ?? current;
        continue;
      }
      if (result.action === 'handled') {
        return { event: current, handled: true, blocked: false, reason: result.reason };
      }
      if (result.action === 'block') {
        return { event: current, handled: false, blocked: true, reason: result.reason };
      }
    }
    return { event: current, handled: false, blocked: false };
  }

  private async runHandler<TEvent, TResult>(
    name: string,
    registration: HookRegistration,
    event: TEvent,
  ): Promise<TResult | undefined> {
    try {
      return (await registration.handler(event, {
        hook: name,
        pluginId: registration.options.pluginId,
      })) as TResult | undefined;
    } catch (error) {
      this.reportHandlerError(error, name, registration.options.pluginId);
      if (registration.options.failPolicy === 'stop') throw error;
      if (registration.options.failPolicy === 'block') {
        return { action: 'block', reason: error instanceof Error ? error.message : String(error) } as TResult;
      }
      return undefined;
    }
  }

  private runHandlerSync<TEvent, TResult>(
    name: string,
    registration: HookRegistration,
    event: TEvent,
  ): TResult | undefined {
    let result: unknown;
    try {
      result = registration.handler(event, {
        hook: name,
        pluginId: registration.options.pluginId,
      });
    } catch (error) {
      this.reportHandlerError(error, name, registration.options.pluginId);
      if (registration.options.failPolicy === 'stop') throw error;
      if (registration.options.failPolicy === 'block') {
        return { action: 'block', reason: error instanceof Error ? error.message : String(error) } as TResult;
      }
      return undefined;
    }
    if (result && typeof result === 'object' && 'then' in result) {
      void Promise.resolve(result).catch((error: unknown) =>
        this.reportHandlerError(error, name, registration.options.pluginId),
      );
      throw new Error(`Hook ${name} must be synchronous`);
    }
    return result as TResult | undefined;
  }

  private reportHandlerError(error: unknown, hook: string, pluginId?: string): void {
    try {
      this.handlerErrorReporter?.(error, hook, pluginId);
    } catch {
      // 观察者本身不能影响 hook 的既有语义（继续 / 阻断 / 抛出）。
    }
  }
}
