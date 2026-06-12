import React from 'react';
import { atom as createAtom, type ReadableAtom, type WritableAtom } from 'nanostores';
import type { IMicaAgent } from '../core/agent';
import type { ConversationMessage } from '../store/conversation.js';
import { uuid } from '../utils/uuid';
import {
  quickCommandsAtom,
  pluginUIsAtom,
  dropdown,
  terminalInput,
  DEFAULT_INPUT_PLACEHOLDER,
  type Command,
  type SessionMeta,
  type PluginUI,
} from '../store/ui-state.js';
import type { SessionToolRecord } from '../store/logAtom.js';
import { useScheduleState } from '../components/ui/hooks/useScheduleState.js';

export interface PluginAtoms {
  messages: WritableAtom<ConversationMessage[]>;
  model: WritableAtom<string>;
  effort: WritableAtom<string>;
  modelOptions: ReadableAtom<Array<{ name: string; label: string }>>;
  effortOptions: ReadableAtom<Array<{ name: string; label: string }>>;
  sessionsIndex: WritableAtom<SessionMeta[]>;
  currentSessionId: WritableAtom<string>;
  sessionSwitch: WritableAtom<string | null>;
  thinkingText: WritableAtom<string>;
  responseText: WritableAtom<string>;
  sessionToolRecords: WritableAtom<SessionToolRecord[]>;
  maxTokens: WritableAtom<number>;
  contextWindowSize: ReadableAtom<number>;
  apiBaseUrl: ReadableAtom<string | undefined>;
  apiKey: ReadableAtom<string | undefined>;
  quickCommands: WritableAtom<Command[]>;
}

export { quickCommandsAtom, type SessionMeta, terminalInput, DEFAULT_INPUT_PLACEHOLDER };

export abstract class MicaPlugin {
  agent!: IMicaAgent;
  atoms!: PluginAtoms;
  _installed = false;

  private _ownedAtoms: Array<{ atom: WritableAtom<any>; initial: any }> = [];

  constructor() {}
  abstract onInstall(): void | Promise<void>;

  onCleanup(): void {}
  onSessionSwitch(_newId: string, _oldId: string): void {}

  protected createState<T>(initial: T): WritableAtom<T> {
    const a = createAtom<T>(initial);
    this._ownedAtoms.push({ atom: a, initial });
    return a;
  }

  protected resetState(): void {
    for (const { atom, initial } of this._ownedAtoms) {
      atom.set(initial);
    }
  }

  public reset(): void {
    this.resetState();
    this.onCleanup();
  }

  protected addQuickCommand(command: Command): void {
    quickCommandsAtom.set([...quickCommandsAtom.get(), command]);
  }

  protected showMessage(text: string, delay: number = 3000, id?: string): string {
    const msgId = id ?? `msg-${uuid()}`;
    if (id) this.removeMessage(msgId);
    this.agent.ui.MessageBar.addMessage({ id: msgId, text });
    if (delay) {
      setTimeout(() => {
        this.removeMessage(msgId);
      }, delay);
    }
    return msgId;
  }

  protected removeMessage(id: string): void {
    this.agent.ui.MessageBar.removeMessage(id);
  }

  protected clearMessages(): void {
    this.agent.ui.MessageBar.clearMessages();
  }

  protected get messages(): ConversationMessage[] {
    return this.atoms.messages.get();
  }

  protected onMessagesChange(cb: (messages: ConversationMessage[]) => void): () => void {
    return this.atoms.messages.listen((msgs) => cb([...msgs]));
  }
}

// ── UIPanelPlugin: 支持交互式 UI 面板的插件基类 ──

export function handleListKeys<T extends { selectedIdx: number }>(
  key: any,
  state: T,
  setState: (s: T) => void,
  length: number,
  onSelect: (idx: number) => void,
  onCancel: () => void,
): boolean {
  if (key.upArrow) {
    setState({ ...state, selectedIdx: state.selectedIdx > 0 ? state.selectedIdx - 1 : length - 1 });
    return true;
  }
  if (key.downArrow) {
    setState({ ...state, selectedIdx: state.selectedIdx < length - 1 ? state.selectedIdx + 1 : 0 });
    return true;
  }
  if (key.return) {
    onSelect(state.selectedIdx);
    return true;
  }
  if (key.escape) {
    onCancel();
    return true;
  }
  return false;
}

export abstract class UIPanelPlugin extends MicaPlugin {
  private _activeUIId: string | null = null;
  private _uiAtom: WritableAtom<any> | null = null;
  private _dropdownUnsubscribe: (() => void) | null = null;

  private _watchDropdownReset(): void {
    if (this._dropdownUnsubscribe) return;
    this._dropdownUnsubscribe = dropdown.state.listen((s) => {
      if (s.visible) {
        this.resetUI();
      }
    });
  }

  private _unwatchDropdownReset(): void {
    if (this._dropdownUnsubscribe) {
      this._dropdownUnsubscribe();
      this._dropdownUnsubscribe = null;
    }
  }

  protected setInputPlaceholder(text: string): void {
    terminalInput.placeholder.set(text);
  }

  protected resetInputPlaceholder(): void {
    terminalInput.placeholder.set(DEFAULT_INPUT_PLACEHOLDER);
  }

  reset(): void {
    this.hideUI();
    super.reset();
  }

  private resetUI(): void {
    this.hideUI();
    this.resetInputPlaceholder();
  }

  protected showUISimple(component: React.ComponentType): void {
    if (!this._installed) {
      console.error(`[${this.constructor.name}] showUISimple called before onInstall completed`);
    }
    this._watchDropdownReset();
    const id = this._activeUIId ?? `plugin-ui-${this.constructor.name}-${uuid()}`;
    this._activeUIId = id;
    const entry: PluginUI = { id, component };
    pluginUIsAtom.set([...pluginUIsAtom.get().filter((u) => u.id !== id), entry]);
  }

  showUI<S>(
    component: React.ComponentType<{ state: S }>,
    initialState: S,
    onInput?: (input: string, key: any, state: S, setState: (s: S) => void) => boolean,
    options?: {
      placeholder?: string;
      preserveInput?: boolean;
      onTextChange?: (text: string, state: S, setState: (s: S) => void) => void;
    },
  ): void {
    if (!this._installed) {
      console.error(`[${this.constructor.name}] showUI called before onInstall completed`);
    }
    this._watchDropdownReset();
    const id = this._activeUIId ?? `plugin-ui-${this.constructor.name}-${uuid()}`;
    this._activeUIId = id;

    if (!this._uiAtom) {
      this._uiAtom = createAtom<S>(initialState);
    }
    this._uiAtom.set(initialState);
    const uiAtom = this._uiAtom;

    const Wrapper: React.ComponentType = () => {
      const state = useScheduleState(uiAtom);
      return React.createElement(component, { state });
    };

    const entry: PluginUI = {
      id,
      component: Wrapper,
      onInput: onInput
        ? (input, key) => onInput(input, key, uiAtom.get(), (s) => uiAtom.set(s))
        : undefined,
      preserveInput: options?.preserveInput,
      onTextChange: options?.onTextChange
        ? (text) => {
            options.onTextChange!(text, uiAtom.get(), (s) => uiAtom.set(s));
            return true;
          }
        : undefined,
    };
    if (options?.placeholder) this.setInputPlaceholder(options.placeholder);
    if (options?.preserveInput) terminalInput.text.set('');
    pluginUIsAtom.set([...pluginUIsAtom.get().filter((u) => u.id !== id), entry]);
  }

  hideUI(): void {
    if (!this._activeUIId) return;
    this._unwatchDropdownReset();
    pluginUIsAtom.set(pluginUIsAtom.get().filter((u) => u.id !== this._activeUIId));
    this._activeUIId = null;
    this._uiAtom = null;
    this.resetInputPlaceholder();
    terminalInput.text.set('');
  }
}
