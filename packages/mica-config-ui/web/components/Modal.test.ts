import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal.js';
vi.mock('react-dom', async (original) => ({
  ...(await original<typeof import('react-dom')>()),
  createPortal: (content: unknown) => content,
}));

const state = vi.hoisted(() => ({ effects: [] as (() => () => void)[], card: null as unknown }));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: (effect: () => () => void) => state.effects.push(effect),
  useRef: (initial: unknown) => ({ current: initial === null ? state.card : initial }),
}));
const cleanups: (() => void)[] = [];
afterEach(async () => {
  while (cleanups.length) cleanups.pop()!();
  await Promise.resolve();
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
  const element = Modal({ title: 'record', children: 'body', onClose, portal });
  cleanups.push(state.effects.pop()!());
  return element;
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

  it('delegates focus and Tab containment to Arco instead of a second DOM trap', () => {
    const press = setup();
    const close = { focus: vi.fn() };
    state.card = {
      querySelector: () => close,
      querySelectorAll: () => [close],
      contains: () => true,
    };
    const element = mount(vi.fn(), true);
    expect(element.props.children.props.focusLock).toBe(true);
    expect(element.props.children.props.autoFocus).toBe(true);
    expect(close.focus).not.toHaveBeenCalled();
    vi.stubGlobal('document', { activeElement: close });
    expect(press('Tab').defaultPrevented).toBe(false);
    expect(press('Tab', true).defaultPrevented).toBe(false);
    expect(close.focus).not.toHaveBeenCalled();
  });

  it('keeps the descendant on top when React mounts child effects before parent effects', () => {
    const press = setup();
    const outer = vi.fn();
    const inner = vi.fn();
    const innerHost = { contains: () => false };
    const outerHost = { contains: (node: unknown) => node === innerHost };
    state.card = innerHost;
    mount(inner);
    state.card = outerHost;
    mount(outer);
    press('Escape');
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  it('restores the connected trigger after a portal is unmounted', async () => {
    setup();
    class Focusable {
      isConnected = true;
      focus = vi.fn();
    }
    vi.stubGlobal('HTMLElement', Focusable);
    const trigger = new Focusable();
    vi.stubGlobal('document', { activeElement: trigger });
    mount(vi.fn(), true);
    cleanups.pop()!();
    await Promise.resolve();
    expect(trigger.focus).toHaveBeenCalledOnce();
  });

  it('keeps the Arco portal in its themed host and delegates Escape only to the shared stack', () => {
    setup();
    const close = { focus: vi.fn() };
    state.card = { querySelector: () => close };
    const element = mount(vi.fn(), true);
    expect(element.props.className).toBe('mica-config-ui is-embed modal-portal');
    const modal = element.props.children;
    expect(modal.props.escToExit).toBe(false);
    expect(modal.props.focusLock).toBe(true);
    expect(modal.props.footer).toBeNull();
    expect(modal.props.getPopupContainer()).toBe(state.card);
    expect(modal.props.modalRender('dialog').props['data-mica-config-modal']).toBe(true);
    expect(modal.props.afterOpen).toBeUndefined();
    expect(close.focus).not.toHaveBeenCalled();
  });
});
