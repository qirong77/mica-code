import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './components/Modal.js';

const state = vi.hoisted(() => ({ effects: [] as (() => () => void)[], host: null as unknown }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: () => () => void) => state.effects.push(effect),
  useRef: (initial: unknown) => ({ current: initial === null ? state.host : initial }),
}));
vi.mock('react-dom', async (original) => ({
  ...(await original<typeof import('react-dom')>()),
  createPortal: (content: unknown) => content,
}));

class Focusable {
  isConnected = true;
  focus = vi.fn();
}
const cleanups: (() => void)[] = [];
afterEach(async () => {
  while (cleanups.length) cleanups.pop()!();
  await Promise.resolve();
  state.effects = [];
  state.host = null;
  vi.unstubAllGlobals();
});

function setup() {
  const trigger = new Focusable();
  const document = { activeElement: trigger, body: {} };
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', document);
  vi.stubGlobal('HTMLElement', Focusable);
  return { trigger, document };
}

function mount() {
  const element = Modal({ title: 'Dialog', onClose: vi.fn(), children: 'body' });
  cleanups.push(state.effects.pop()!());
  return element;
}

describe('shared modal focus ownership', () => {
  it.each([false, true])('delegates focus containment to Arco for portal=%s', async (portal) => {
    const { trigger } = setup();
    const element = Modal({ title: 'Dialog', onClose: vi.fn(), children: 'body', portal });
    cleanups.push(state.effects.pop()!());
    const modal = element.props.children;
    expect(modal.props.focusLock).toBe(true);
    expect(modal.props.autoFocus).toBe(true);
    expect(modal.props.escToExit).toBe(false);
    // No delayed close-button focus may override a child's Input autoFocus.
    expect(modal.props.afterOpen).toBeUndefined();
    expect(trigger.focus).not.toHaveBeenCalled();
    // react-focus-lock tracks React portals; do not intercept popup Tab events
    // with a second, DOM-only trap outside Arco's focus scope.
    const tab = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Tab' });
    window.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    cleanups.pop()!();
    expect(trigger.focus).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(trigger.focus).toHaveBeenCalledOnce();
  });

  it('captures the opener before child autofocus and restores it for inline dialogs', async () => {
    const { trigger, document } = setup();
    Modal({ title: 'Prompt', onClose: vi.fn(), children: 'body' });
    const input = new Focusable();
    document.activeElement = input;
    cleanups.push(state.effects.pop()!());
    expect(input.focus).not.toHaveBeenCalled();
    cleanups.pop()!();
    await Promise.resolve();
    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(input.focus).not.toHaveBeenCalled();
  });

  it('does not restore a disconnected opener', async () => {
    const { trigger } = setup();
    mount();
    trigger.isConnected = false;
    cleanups.pop()!();
    await Promise.resolve();
    expect(trigger.focus).not.toHaveBeenCalled();
  });

  it('does not steal focus when a covered dialog is removed', async () => {
    const { trigger, document } = setup();
    mount();
    const removeOuter = cleanups.pop()!;
    const innerTrigger = new Focusable();
    document.activeElement = innerTrigger;
    mount();
    removeOuter();
    expect(trigger.focus).not.toHaveBeenCalled();
    cleanups.pop()!();
    await Promise.resolve();
    expect(innerTrigger.focus).toHaveBeenCalledOnce();
  });

  it('does not steal focus from a replacement mounted before restoration', async () => {
    const { trigger } = setup();
    mount();
    cleanups.pop()!();
    mount();
    await Promise.resolve();
    expect(trigger.focus).not.toHaveBeenCalled();
  });
});
