import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SelectMenu } from './SelectMenu.js';
import { DateField } from './DateField.js';
import { DataTable } from './DataTable.js';

const state = vi.hoisted(() => ({ direct: false, page: 0, setPage: vi.fn() }));
vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  return {
    ...react,
    useRef: (initial: unknown) => (state.direct ? { current: initial } : react.useRef(initial)),
    useState: (initial: unknown) =>
      state.direct ? [typeof initial === 'number' ? state.page : initial, state.setPage] : react.useState(initial),
    useMemo: (factory: () => unknown, deps: unknown[]) => (state.direct ? factory() : react.useMemo(factory, deps)),
    useEffect: (effect: () => void, deps: unknown[]) => (state.direct ? undefined : react.useEffect(effect, deps)),
  };
});

afterEach(() => {
  state.direct = false;
  state.page = 0;
  state.setPage.mockReset();
  vi.unstubAllGlobals();
});

function render(element: ReactElement) {
  return renderToStaticMarkup(element);
}

describe('Arco composite controls', () => {
  it('renders empty-string selections and stale-value fallback without an App provider', () => {
    const empty = render(
      createElement(SelectMenu, {
        value: '',
        options: [{ value: '', label: 'Follow first provider' }],
        onChange: vi.fn(),
        size: 'compact',
      }),
    );
    expect(empty).toContain('arco-select');
    expect(empty).toContain('Follow first provider');
    expect(empty).toContain('arco-select-size-mini');
    expect(
      render(
        createElement(SelectMenu, {
          value: 'deleted',
          options: [],
          fallbackLabel: 'Missing provider',
          onChange: vi.fn(),
        }),
      ),
    ).toContain('Missing provider');
  });

  it('keeps groups, disabled options, token filtering, and popup containment', () => {
    state.direct = true;
    const changed = vi.fn();
    const root = SelectMenu({
      value: '',
      filterable: true,
      menuMinWidth: 240,
      onChange: changed,
      options: [
        { value: '', label: 'Automatic' },
        { value: 'release/nov', label: 'November release', group: 'Branches' },
        { value: 'blocked', group: 'Branches', disabled: true },
      ],
    });
    const props = root.props.children.props;
    expect(props.children[1].props.label).toBe('Branches');
    expect(props.children[1].props.children[1].props.disabled).toBe(true);
    expect(props.filterOption('NOV release', { props: { value: 'release/nov' } })).toBe(true);
    expect(props.filterOption('NOV other', { props: { value: 'release/nov' } })).toBe(false);
    props.onChange('blocked');
    props.onChange('');
    expect(changed).not.toHaveBeenCalled();
    props.onChange('release/nov');
    expect(changed).toHaveBeenCalledWith('release/nov');
    const themed = {};
    expect(props.getPopupContainer({ closest: () => themed })).toBe(themed);
    const parent = {};
    expect(props.getPopupContainer({ closest: () => null, parentElement: parent })).toBe(parent);
    expect(props.dropdownMenuStyle).toEqual({ minWidth: 240 });
  });

  it('renders an editable local ISO date and preserves input accessibility and size', () => {
    const html = render(
      createElement(DateField, {
        id: 'due',
        value: '2026-11-02',
        ariaLabel: 'Due date',
        invalid: true,
        size: 'compact',
        onChange: vi.fn(),
      }),
    );
    expect(html).toContain('arco-picker');
    expect(html).toContain('arco-picker-size-mini');
    expect(html).toContain('value="2026-11-02"');
    expect(html).toContain('id="due"');
    expect(html).toContain('aria-label="Due date"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).not.toContain('readonly');
  });

  it('clamps typed dates, accepts clearing, rejects invalid days and never requests UTC', () => {
    state.direct = true;
    const changed = vi.fn();
    const root = DateField({ value: '2026-11-05', min: '2026-11-02', max: '2026-11-20', onChange: changed });
    const props = root.props.children.props;
    expect(props.utcOffset).toBeUndefined();
    expect(props.timezone).toBeUndefined();
    expect(props.dayStartOfWeek).toBe(1);
    expect(props.disabledDate({ format: () => '2026-11-01' })).toBe(true);
    expect(props.disabledDate({ format: () => '2026-11-20' })).toBe(false);
    props.onChange('2026-11-25');
    expect(changed).toHaveBeenLastCalledWith('2026-11-20');
    props.onChange(undefined);
    expect(changed).toHaveBeenLastCalledWith('');
    changed.mockClear();
    props.onChange('2026-02-30');
    expect(changed).not.toHaveBeenCalled();
    class Input {
      value = '2026-10-25';
    }
    vi.stubGlobal('HTMLInputElement', Input);
    root.props.onBlurCapture({ target: new Input() });
    expect(changed).toHaveBeenLastCalledWith('2026-11-02');
    const event = {
      target: new Input(),
      key: 'Enter',
      nativeEvent: {},
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    root.props.onKeyDownCapture(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    changed.mockClear();
    const typed = new Input();
    typed.value = '2026-11-12';
    root.props.onInputCapture({ target: typed });
    props.onVisibleChange(false);
    expect(changed).toHaveBeenLastCalledWith('2026-11-12');
    root.props.onKeyDownCapture({ ...event, key: 'Tab', target: typed });
    expect(state.setPage).toHaveBeenLastCalledWith(false);
  });

  it('uses Arco Table with td/th hiding classes and evaluates cells once per visible row', () => {
    const cells = vi.fn((row: { id: string }) => [row.id, `detail-${row.id}`]);
    const html = render(
      createElement(DataTable<{ id: string }>, {
        ariaLabel: 'Records',
        columns: [
          { key: 'name', label: 'Name', sortable: true, width: '60%' },
          { key: 'detail', label: 'Details', narrow: 'secondary', align: 'right' },
        ],
        rows: [{ id: 'second' }, { id: 'first' }, { id: 'third' }],
        rowKey: (row) => row.id,
        renderCells: cells,
        pageSize: 2,
        sort: { key: 'name', desc: true },
      }),
    );
    expect(cells).toHaveBeenCalledTimes(2);
    expect(html).toContain('arco-table');
    expect(html).toMatch(/<table[^>]*aria-label="Records"/);
    expect(html).toMatch(/<th[^>]*class="[^"]*data-table-cell is-num is-narrow-secondary/);
    expect(html).toMatch(/<td[^>]*class="[^"]*data-table-cell is-num is-narrow-secondary/);
    expect(html).toContain('width:60%');
    expect(html.indexOf('detail-second')).toBeLessThan(html.indexOf('detail-first'));
    expect(html).not.toContain('detail-third');
    expect(html).toContain('1–2 / 3');
    expect(html).toContain('▼');
  });

  it('only requests external sorting and retains shared pagination', () => {
    state.direct = true;
    const sorted = vi.fn();
    const root = DataTable({
      columns: [{ key: 'id', label: 'Identifier', narrowLabel: 'ID', sortable: true }],
      rows: ['b', 'a', 'c'],
      rowKey: (row) => row,
      renderCells: (row) => [row],
      pageSize: 2,
      sort: { key: 'id', desc: false },
      onSortChange: sorted,
    });
    const [table, footer] = root.props.children;
    table.props.columns[0].title.props.onClick();
    expect(sorted).toHaveBeenCalledExactlyOnceWith('id');
    expect(table.props.data.map((row: { key: string }) => row.key)).toEqual(['b', 'a']);
    expect(table.props.columns[0].sorter).toBeUndefined();
    const pager = footer.props.children[1];
    pager.props.children[2].props.onClick();
    expect(state.setPage).toHaveBeenCalledWith(1);
  });

  it('renders the supplied empty table message', () => {
    const html = render(
      createElement(DataTable<string>, {
        columns: [{ key: 'id', label: 'ID' }],
        rows: [],
        rowKey: (row) => row,
        renderCells: (row) => [row],
        emptyText: 'No records yet',
      }),
    );
    expect(html).toContain('No records yet');
  });
});
