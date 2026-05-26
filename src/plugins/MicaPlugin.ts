import React from 'react';
import { atom as createAtom, type ReadableAtom, type WritableAtom } from 'nanostores';
import type { IMicaAgent } from '../core/agent';
import type Anthropic from '@anthropic-ai/sdk';
import { uuid } from '../utils/uuid';
import { quickCommandsAtom, pluginUIsAtom, dropdown, type Command, type SessionMeta, type PluginUI } from '../store/ui-state.js';
import type { SessionToolRecord } from '../store/logAtom.js';
import { useSchedulState } from '../components/ui/hooks/useSchedulState.js';

export interface PluginAtoms {
  messages: WritableAtom<Anthropic.MessageParam[]>;
  model: WritableAtom<string>;
  effort: WritableAtom<string>;
  modelOptions: ReadableAtom<Array<{ name: string; label: string }>>;
  effortOptions: ReadableAtom<Array<{ name: string; label: string }>>;
  sessionsIndex: WritableAtom<SessionMeta[]>;
  currentSessionId: WritableAtom<string>;
  sessionSwitch: WritableAtom<string | null>;
  logText: WritableAtom<string>;
  sessionToolRecords: WritableAtom<SessionToolRecord[]>;
  systemLogVisible: WritableAtom<boolean>;
  maxTokens: WritableAtom<number>;
  contextWindowSize: ReadableAtom<number>;
  apiBaseUrl: ReadableAtom<string | undefined>;
  apiKey: ReadableAtom<string | undefined>;
  quickCommands: WritableAtom<Command[]>;
}

// ── 快速命令列表（由插件注册，插件内部闭环） ────────────

export { quickCommandsAtom, type SessionMeta };

/**
 * MicaPlugin 基类
 *
 * 所有插件应继承此类，通过 `this.agent` 访问 MicaAgent 实例，
 * 通过 `this.agent.ui` 访问 UI 组件对象（消息、思考文本、工具调用、下拉菜单等）。
 * 通过 `this.atoms` 访问由父组件注入的响应式 atom。
 */
export abstract class MicaPlugin {
  agent!: IMicaAgent;

  atoms!: PluginAtoms;

  private _activeUIId: string | null = null;
  private _uiAtom: WritableAtom<any> | null = null;

  constructor() {
    dropdown.atom.listen((state) => {
      if (state.visible) this.hideUI();
    });
  }
  abstract onInstall(): void | Promise<void>;

  protected addQuickCommand(command: Command): void {
    quickCommandsAtom.set([...quickCommandsAtom.get(), command]);
  }

  /**
   * 显示插件 UI（无状态版本，适用于静态展示如 spinner）
   */
  protected showUISimple(component: React.ComponentType): void {
    const id = this._activeUIId ?? `plugin-ui-${uuid()}`;
    this._activeUIId = id;
    const entry: PluginUI = { id, component };
    pluginUIsAtom.set([...pluginUIsAtom.get().filter((u) => u.id !== id), entry]);
  }

  /**
   * 显示插件 UI，使用 atom 管理状态。
   * 
   * @param component - React 组件，接收 `{ state }` prop
   * @param initialState - 初始状态
   * @param onInput - 输入回调，接收 (input, key, state, setState)，返回 true 表示已处理
   */
  protected showUI<S>(
    component: React.ComponentType<{ state: S }>,
    initialState: S,
    onInput?: (input: string, key: any, state: S, setState: (s: S) => void) => boolean,
  ): void {
    const id = this._activeUIId ?? `plugin-ui-${uuid()}`;
    this._activeUIId = id;

    if (!this._uiAtom) {
      this._uiAtom = createAtom<S>(initialState);
    }
    this._uiAtom.set(initialState);
    const uiAtom = this._uiAtom;

    const Wrapper: React.ComponentType = () => {
      const state = useSchedulState(uiAtom);
      return React.createElement(component, { state });
    };

    const entry: PluginUI = {
      id,
      component: Wrapper,
      onInput: onInput
        ? (input, key) => onInput(input, key, uiAtom.get(), (s) => uiAtom.set(s))
        : undefined,
    };
    pluginUIsAtom.set([...pluginUIsAtom.get().filter((u) => u.id !== id), entry]);
  }

  protected hideUI(): void {
    if (!this._activeUIId) return;
    pluginUIsAtom.set(pluginUIsAtom.get().filter((u) => u.id !== this._activeUIId));
    this._activeUIId = null;
    this._uiAtom = null;
  }

  /** 显示一条消息（通过 UI 组件事件），默认 3s 后自动清除 */
  protected showMessage(text: string, delay: number = 3000): string {
    const msgId = `msg-${uuid()}`;
    this.agent.ui.MessageBar.addMessage({ id: msgId, text });
    if (delay) {
      setTimeout(() => {
        this.removeMessage(msgId);
      }, delay);
    }
    return msgId;
  }

  /** 移除指定 ID 的消息 */
  protected removeMessage(id: string): void {
    this.agent.ui.MessageBar.removeMessage(id);
  }

  /** 清除所有消息 */
  protected clearMessages(): void {
    this.agent.ui.MessageBar.clearMessages();
  }

  /** 获取当前消息列表 */
  protected get messages(): Anthropic.MessageParam[] {
    return this.atoms.messages.get();
  }

  /** 监听消息变更 */
  protected onMessagesChange(cb: (messages: Anthropic.MessageParam[]) => void): () => void {
    return this.atoms.messages.listen((messages) => cb([...messages]));
  }
}
