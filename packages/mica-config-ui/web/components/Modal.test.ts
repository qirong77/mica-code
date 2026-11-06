import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal.js';

const state = vi.hoisted(() => ({ effects: [] as (() => () => void)[], card: null as unknown }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: () => () => void) => state.effects.push(effect),
  useRef: (initial: unknown) => ({ current: initial === null ? state.card : initial }),
}));
vi.mock('react-dom', () => ({ createPortal: (content: unknown) => content }));

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  state.effects = [];
  state.card = null;
  vi.unstubAllGlobals();
});

function setup() {
  const window = new EventTarget();
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', { activeElement: null, body: {} });
  vi.stubGlobal('HTMLElement', class {});
  return (key: string, shiftKey = false) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key, shiftKey });
    window.dispatchEvent(event);
    return event;
  };
}

function mount(onClose: () => void, portal = false) {
  Modal({ title: 'record', children: 'body', onClose, portal });
  cleanups.push(state.effects.pop()!());
}

describe('nested config modal keyboard behavior', () => {
  it('closes only the top config dialog and releases it on unmount', () => {
    const press = setup();
    const outer = vi.fn();
    const inner = vi.fn();
    mount(outer);
    mount(inner);
    expect(press('Escape').defaultPrevented).toBe(true);
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
    cleanups.pop()!();
    press('Escape');
    expect(outer).toHaveBeenCalledOnce();
  });

  it('focuses the close control and keeps forward/backward Tab inside the portal', () => {
    const press = setup();
    const close = { focus: vi.fn() };
    state.card = {
      querySelector: () => close,
      querySelectorAll: () => [close],
      contains: () => true,
    };
    mount(vi.fn(), true);
    expect(close.focus).toHaveBeenCalledOnce();
    vi.stubGlobal('document', { activeElement: close });
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(press('Tab', true).defaultPrevented).toBe(true);
    expect(close.focus).toHaveBeenCalledTimes(3);
  });
});
