import { atom } from 'nanostores';
import mitt from 'mitt';

export type TerminalInputQueueMode = 'after_iteration' | 'after_turn';
export type TerminalInputSubmitOptions = {
  queueMode?: TerminalInputQueueMode;
  displayText?: string;
};

export interface TerminalFileMentionItem {
  path: string;
  label?: string;
  description?: string;
  labelHighlights?: number[];
}

export type TerminalFileMentionProvider = (query: string) => Promise<TerminalFileMentionItem[]>;

type SubmitHandler = (text: string, options?: TerminalInputSubmitOptions) => void;
type SubmitEvent = { text: string; options?: TerminalInputSubmitOptions };
type Events = { submit: SubmitEvent };
const emitter = mitt<Events>();
const submitHandlers = new WeakMap<SubmitHandler, (event: SubmitEvent) => void>();
type ExitRequestedHandler = (exitCode: number) => void | Promise<void>;
let exitRequestedHandler: ExitRequestedHandler | null = null;
let cycleRoleHandler: (() => void) | null = null;
let baseFileMentionProvider: TerminalFileMentionProvider | null = null;
const fileMentionProviderRegistrations: Array<{ provider: TerminalFileMentionProvider }> = [];

export const text = atom('');
export const disabled = atom(false);
export const placeholder = atom('Type something and press Enter...');
export const inputBottomDistance = atom(0);
export const queueStatusText = atom('');
export const role = atom('default');

export function clearText(): void {
  text.set('');
}

export function setQueueStatusText(value: string): void {
  queueStatusText.set(value);
}

export function setPlaceholder(value: string): void {
  placeholder.set(value);
}

export function onSubmit(cb: SubmitHandler) {
  const handler = (event: SubmitEvent) => cb(event.text, event.options);
  submitHandlers.set(cb, handler);
  emitter.on('submit', handler);
  return () => {
    emitter.off('submit', handler);
    submitHandlers.delete(cb);
  };
}

export function submit(text: string, options?: TerminalInputSubmitOptions) {
  emitter.emit('submit', { text, options });
}

export function offSubmit(cb: SubmitHandler) {
  const handler = submitHandlers.get(cb);
  if (!handler) return;
  emitter.off('submit', handler);
  submitHandlers.delete(cb);
}

export function setOnExitRequested(cb: ExitRequestedHandler | null): void {
  exitRequestedHandler = cb;
}

export async function requestExit(exitCode = 0): Promise<void> {
  if (exitRequestedHandler) {
    await exitRequestedHandler(exitCode);
    return;
  }
  process.exit(exitCode);
}

export function setOnCycleRole(cb: (() => void) | null): void {
  cycleRoleHandler = cb;
}

export function cycleRole(): void {
  cycleRoleHandler?.();
}

export function setFileMentionProvider(provider: TerminalFileMentionProvider | null): void {
  baseFileMentionProvider = provider;
}

export function registerFileMentionProvider(provider: TerminalFileMentionProvider): { dispose(): void } {
  const registration = { provider };
  fileMentionProviderRegistrations.push(registration);
  return {
    dispose: () => {
      const index = fileMentionProviderRegistrations.indexOf(registration);
      if (index >= 0) fileMentionProviderRegistrations.splice(index, 1);
    },
  };
}

export function hasFileMentionProvider(): boolean {
  return fileMentionProviderRegistrations.length > 0 || baseFileMentionProvider !== null;
}

export function findFileMentions(query: string): Promise<TerminalFileMentionItem[]> {
  const provider = fileMentionProviderRegistrations.at(-1)?.provider ?? baseFileMentionProvider;
  return provider?.(query) ?? Promise.resolve([]);
}
