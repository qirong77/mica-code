import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandRegistry } from '@packages/mica-commands/index.js';
import { micaUi } from '@packages/mica-ui/index.js';
import type { LocalRuntimeController } from './adapters/LocalRuntimeController.js';
import { trackCommandDropdown } from './Application.js';

afterEach(() => vi.restoreAllMocks());

describe('command dropdown', () => {
  it('initializes before the first turn and updates when commands change', () => {
    const setQuickCommands = vi.spyOn(micaUi.dropdown, 'setQuickCommands').mockImplementation(() => {});
    let entries = [{ name: 'first', description: 'First command' }];
    const commands = { list: () => entries } as unknown as CommandRegistry;
    const submit = vi.fn();
    const runtime = { submit } as unknown as LocalRuntimeController;
    const sync = trackCommandDropdown(commands, runtime);

    expect(setQuickCommands).toHaveBeenCalledTimes(1);
    expect(setQuickCommands.mock.calls[0][0]).toEqual([
      expect.objectContaining({ name: 'first', description: 'First command' }),
    ]);
    sync();
    expect(setQuickCommands).toHaveBeenCalledTimes(1);
    entries = [];
    sync();
    expect(setQuickCommands).toHaveBeenLastCalledWith([]);
  });

  it('clears a previous dropdown even when the initial registry is empty', () => {
    const setQuickCommands = vi.spyOn(micaUi.dropdown, 'setQuickCommands').mockImplementation(() => {});
    trackCommandDropdown({ list: () => [] } as unknown as CommandRegistry, {} as LocalRuntimeController);
    expect(setQuickCommands).toHaveBeenCalledWith([]);
  });
});
