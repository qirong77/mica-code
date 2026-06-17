import { atom } from 'nanostores';
import mitt from 'mitt';

type Events = { submit: string };
export const emitter = mitt<Events>();

export const text = atom('');
export const disabled = atom(false);
export const placeholder = atom('Type something and press Enter...');
export const inputBottomDistance = atom(0);

export function setText(value: string): void {
  text.set(value);
}

export function clearText(): void {
  text.set('');
}

export function setDisabled(value: boolean): void {
  disabled.set(value);
}

export function setPlaceholder(value: string): void {
  placeholder.set(value);
}

export function onSubmit(cb: (text: string) => void) {
  emitter.on('submit', cb);
  return () => emitter.off('submit', cb);
}

export function submit(text: string) {
  emitter.emit('submit', text);
}

export function offSubmit(cb: (text: string) => void) {
  emitter.off('submit', cb);
}
