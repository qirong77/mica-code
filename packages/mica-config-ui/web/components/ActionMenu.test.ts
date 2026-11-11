import type { ForwardRefRenderFunction, HTMLAttributes, KeyboardEvent, ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MenuList, type MenuListProps } from './ActionMenu.js';

// Keep the existing Node-only UI test environment; focus targets model the DOM boundary.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useRef: (current: unknown) => ({ current }),
  useImperativeHandle: () => {},
  useEffect: () => {},
}));

function keyboardHandler(props: MenuListProps = {}) {
  const render = (MenuList as unknown as { render: ForwardRefRenderFunction<HTMLDivElement, MenuListProps> }).render;
  const element = render(props, null) as ReactElement<HTMLAttributes<HTMLDivElement>>;
  return element.props.onKeyDown!;
}

function menuFixture() {
  const ownerDocument = { activeElement: null as unknown };
  const rows: HTMLElement[] = [];
  const menu = {
    ownerDocument,
    querySelectorAll: () => rows,
    closest: (selector: string) => (selector === '.mica-menu' ? menu : null),
  } as unknown as HTMLDivElement;

  function item(options: { disabled?: boolean; ariaDisabled?: boolean; nested?: boolean } = {}) {
    const row = {
      closest: () => (options.nested ? {} : menu),
      matches: (selector: string) =>
        !!(
          (options.disabled && selector.includes(':disabled')) ||
          (options.ariaDisabled && selector.includes('[aria-disabled="true"]'))
        ),
      focus: vi.fn(() => {
        ownerDocument.activeElement = row;
      }),
    };
    rows.push(row as unknown as HTMLElement);
    return row;
  }

  function input(tag: 'input' | 'textarea' | 'contenteditable') {
    const target = {
      getAttribute: () => 'true',
      closest: (selector: string): unknown => {
        if (selector === '.mica-menu') return menu;
        if (selector === '[contenteditable]') return tag === 'contenteditable' ? target : null;
        return tag !== 'contenteditable' && selector.includes(tag) ? target : null;
      },
    };
    return target as unknown as HTMLElement;
  }

  function press(handler: ReturnType<typeof keyboardHandler>, key: string, target: HTMLElement = menu) {
    const event = {
      key,
      target,
      currentTarget: menu,
      defaultPrevented: false,
      preventDefault: vi.fn(() => {
        event.defaultPrevented = true;
      }),
      stopPropagation: vi.fn(),
    };
    handler(event as unknown as KeyboardEvent<HTMLDivElement>);
    return event;
  }

  return { menu, ownerDocument, item, input, press };
}

describe('shared action-menu keyboard behavior', () => {
  it('wraps between enabled items in the current menu, including Home and End', () => {
    const { ownerDocument, item, press } = menuFixture();
    const first = item();
    const disabled = item({ disabled: true });
    const ariaDisabled = item({ ariaDisabled: true });
    const nested = item({ nested: true });
    const last = item();
    const handle = keyboardHandler();

    expect(press(handle, 'ArrowDown').defaultPrevented).toBe(true);
    expect(ownerDocument.activeElement).toBe(first);
    press(handle, 'ArrowDown');
    expect(ownerDocument.activeElement).toBe(last);
    press(handle, 'ArrowDown');
    expect(ownerDocument.activeElement).toBe(first);
    press(handle, 'ArrowUp');
    expect(ownerDocument.activeElement).toBe(last);
    press(handle, 'Home');
    expect(ownerDocument.activeElement).toBe(first);
    press(handle, 'End');
    expect(ownerDocument.activeElement).toBe(last);
    for (const skipped of [disabled, ariaDisabled, nested]) expect(skipped.focus).not.toHaveBeenCalled();
  });

  it('preserves editing keys and closes once on Escape or Tab without trapping Tab', () => {
    const { item, input, press } = menuFixture();
    const row = item();
    const onClose = vi.fn();
    const handle = keyboardHandler({ onClose });

    for (const tag of ['input', 'textarea', 'contenteditable'] as const) {
      for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
        const event = press(handle, key, input(tag));
        expect(event.defaultPrevented).toBe(false);
        expect(event.stopPropagation).not.toHaveBeenCalled();
      }
    }
    expect(row.focus).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    for (const key of ['Escape', 'Tab']) {
      onClose.mockClear();
      const event = press(handle, key, input('input'));
      expect(onClose).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(key === 'Escape');
    }
  });
});
