import { atom } from 'nanostores';
import mitt from 'mitt';

export type TerminalInputQueueMode = 'after_iteration' | 'after_turn';
export type TerminalInputSubmitOptions = {
  queueMode?: TerminalInputQueueMode;
  displayText?: string;
};

type SubmitHandler = (text: string, options?: TerminalInputSubmitOptions) => void;
type SubmitEvent = { text: string; options?: TerminalInputSubmitOptions };
type Events = { submit: SubmitEvent };
const emitter = mitt<Events>();
const submitHandlers = new WeakMap<SubmitHandler, (event: SubmitEvent) => void>();
let exitRequestedHandler: (() => void) | null = null;

export const text = atom('');
export const disabled = atom(false);
export const placeholder = atom('Type something and press Enter...');
export const inputBottomDistance = atom(0);
export const queueStatusText = atom('');

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

export function setOnExitRequested(cb: (() => void) | null): void {
  exitRequestedHandler = cb;
}

export function requestExit(): void {
  if (exitRequestedHandler) {
    exitRequestedHandler();
    return;
  }
  process.exit(0);
}
