import React from 'react';
import { Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import type { SelectItem } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';
import { moveSelection, selectionDirection } from './commandInput.js';

export type SelectOption = {
  name: string;
  label: React.ReactNode;
  status?: React.ReactNode;
  description?: React.ReactNode;
  suffix?: React.ReactNode;
  labelWidth?: number | string;
  labelMaxWidth?: number | string;
  searchField?: string;
};

export type SelectCommandConfig = {
  id: string;
  title: string | ((currentIndex: number, total: number) => string);
  current: string;
  options: SelectOption[];
  emptyMessage?: string;
  itemGap?: number;
  renderItem?: (item: SelectItem, isSelected: boolean) => React.ReactNode;
  onSelect: (name: string) => void | boolean | Promise<void | boolean>;
  onAfterSelect?: (name: string) => void | Promise<void>;
  filterable?: boolean;
};

export function showSelectCommand(config: SelectCommandConfig) {
  micaLogger.logRuntime('plugin.select', 'opened', {
    id: config.id,
    title: config.title,
    current: config.current,
    options: config.options.length,
  });
  const initialIndex = Math.max(
    0,
    config.options.findIndex((option) => option.name === config.current),
  );
  const selectedIdx = atom(initialIndex);
  const applying = atom(false);
  const searchText = atom('');

  function resolveSearchField(option: SelectOption): string {
    if (typeof option.searchField === 'string') return option.searchField;
    if (typeof option.label === 'string') return option.label;
    return option.name;
  }

  function getFilteredOptions(): SelectOption[] {
    const text = searchText.get().toLowerCase();
    if (!text || !config.filterable) return config.options;
    return config.options.filter((option) => resolveSearchField(option).toLowerCase().includes(text));
  }

  function hide() {
    micaLogger.logRuntime('plugin.select', 'closed', { id: config.id, title: config.title });
    micaUi.terminalInput.clearText();
    micaUi.panels.clearPluginUIs();
  }

  function selectCurrent() {
    if (applying.get()) return;
    const filtered = getFilteredOptions();
    const selected = filtered[selectedIdx.get()];
    if (selected) {
      micaLogger.logRuntime('plugin.select', 'selected', { id: config.id, title: config.title, value: selected.name });
      applying.set(true);
      let shouldRunAfterSelect = false;
      void Promise.resolve()
        .then(() => config.onSelect(selected.name))
        .then((result) => {
          shouldRunAfterSelect = result !== false;
        })
        .catch((error) => {
          micaLogger.logRuntime(
            'plugin.select',
            'select:error',
            {
              id: config.id,
              title: config.title,
              error: error instanceof Error ? error.message : String(error),
            },
            'error',
          );
        })
        .finally(() => {
          applying.set(false);
          hide();
          if (shouldRunAfterSelect && config.onAfterSelect) {
            void Promise.resolve()
              .then(() => config.onAfterSelect?.(selected.name))
              .catch((error) => {
                micaLogger.logRuntime(
                  'plugin.select',
                  'after_select:error',
                  {
                    id: config.id,
                    title: config.title,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  'error',
                );
              });
          }
        });
    } else {
      micaLogger.logRuntime('plugin.select', 'select:empty', { id: config.id, title: config.title }, 'warn');
      hide();
    }
  }

  function SelectorPanel() {
    const currentIdx = micaUi.useScheduleState(selectedIdx);
    const isApplying = micaUi.useScheduleState(applying);
    const filtered = getFilteredOptions();
    const items: SelectItem[] = filtered.map((option) => ({
      key: option.name,
      label: option.label,
      status: option.status,
      description: option.description,
      labelWidth: option.labelWidth,
      labelMaxWidth: option.labelMaxWidth,
      suffix:
        option.name === config.current ? <Text color={micaUi.theme.colors.success}> (active)</Text> : option.suffix,
    }));

    const titleText = typeof config.title === 'function' ? config.title(currentIdx, items.length) : config.title;

    return (
      <micaUi.Dialog
        title={isApplying ? `${titleText} (applying...)` : titleText}
        footer={
          <micaUi.KeyHints
            hints={
              isApplying
                ? ['applying']
                : config.filterable
                  ? ['type to filter', '↑↓ navigate', '↵ select', 'esc cancel']
                  : ['↑↓ navigate', '↵ select', 'esc cancel']
            }
          />
        }
      >
        <micaUi.SelectList
          items={items}
          adaptiveHeight
          selectedIdx={currentIdx}
          empty={<Text dimColor>{config.emptyMessage ?? 'no options'}</Text>}
          itemGap={config.itemGap ?? 1}
          layout="table"
          renderItem={config.renderItem}
        />
      </micaUi.Dialog>
    );
  }

  micaUi.terminalInput.clearText();

  micaUi.panels.setExclusivePluginUI({
    id: config.id,
    component: SelectorPanel,
    preserveInput: true,
    onTextChange: config.filterable
      ? (text) => {
          searchText.set(text);
          selectedIdx.set(0);
          return true;
        }
      : undefined,
    onInput: (_input, key) => {
      if (applying.get()) return true;
      if (key.escape) {
        hide();
        return true;
      }
      if (key.return || key.tab) {
        selectCurrent();
        return true;
      }
      const direction = selectionDirection(key);
      if (direction) {
        const filtered = getFilteredOptions();
        if (filtered.length > 0) selectedIdx.set(moveSelection(selectedIdx.get(), filtered.length, direction));
        return true;
      }
      return false;
    },
  });
}

export function showConfirmPrompt(message: string, defaultYes = true): Promise<boolean> {
  return new Promise((resolve) => {
    micaLogger.logRuntime('plugin.confirm', 'opened', { message });
    const yesIdx = defaultYes ? 0 : 1;
    const noIdx = defaultYes ? 1 : 0;
    const selectedIdx = atom(yesIdx);
    let resolved = false;

    function hide() {
      micaLogger.logRuntime('plugin.confirm', 'closed', { message });
      micaUi.panels.clearPluginUIs();
    }

    function finish(value: boolean) {
      if (resolved) return;
      resolved = true;
      micaLogger.logRuntime('plugin.confirm', 'resolved', { message, value });
      hide();
      resolve(value);
    }

    function ConfirmPanel() {
      const currentIdx = micaUi.useScheduleState(selectedIdx);
      const items: SelectItem[] = [
        { key: 'yes', label: 'Yes, compact first' },
        { key: 'no', label: 'No, switch directly' },
      ];

      return (
        <micaUi.Dialog
          title={message}
          footer={<micaUi.KeyHints hints={['↑↓ navigate', '↵ select', 'esc cancel (no)']} />}
        >
          <micaUi.SelectList items={items} selectedIdx={currentIdx} itemGap={1} />
        </micaUi.Dialog>
      );
    }

    micaUi.panels.setExclusivePluginUI({
      id: 'confirm-prompt',
      component: ConfirmPanel,
      onInput: (_input, key) => {
        if (resolved) return true;
        if (key.escape) {
          finish(false);
          return true;
        }
        if (key.return || key.tab) {
          finish(selectedIdx.get() === yesIdx);
          return true;
        }
        if (selectionDirection(key)) {
          selectedIdx.set(selectedIdx.get() === yesIdx ? noIdx : yesIdx);
          return true;
        }
        return false;
      },
    });
  });
}
