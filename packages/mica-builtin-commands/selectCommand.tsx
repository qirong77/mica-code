import React from 'react';
import { Text } from '@anthropic/ink';
import { atom } from 'nanostores';
import { micaUi } from '@packages/mica-ui/index.js';
import type { SelectItem } from '@packages/mica-ui/index.js';
import { micaLogger } from '@packages/mica-logger/index.js';

export type SelectOption = {
  name: string;
  label: React.ReactNode;
};

export type SelectCommandConfig = {
  id: string;
  title: string;
  current: string;
  options: SelectOption[];
  emptyMessage?: string;
  onSelect: (name: string) => void | Promise<void>;
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

  function hide() {
    micaLogger.logRuntime('plugin.select', 'closed', { id: config.id, title: config.title });
    micaUi.panels.clearPluginUIs();
  }

  function selectCurrent() {
    if (applying.get()) return;
    const selected = config.options[selectedIdx.get()];
    if (selected) {
      micaLogger.logRuntime('plugin.select', 'selected', { id: config.id, title: config.title, value: selected.name });
      applying.set(true);
      void Promise.resolve(config.onSelect(selected.name))
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
        });
    } else {
      micaLogger.logRuntime('plugin.select', 'select:empty', { id: config.id, title: config.title }, 'warn');
      hide();
    }
  }

  function SelectorPanel() {
    const currentIdx = micaUi.useScheduleState(selectedIdx);
    const isApplying = micaUi.useScheduleState(applying);
    const items: SelectItem[] = config.options.map((option) => ({
      key: option.name,
      label: option.label,
      suffix: option.name === config.current ? <Text color={micaUi.theme.colors.success}> (active)</Text> : undefined,
    }));

    return (
      <micaUi.Dialog
        title={isApplying ? `${config.title} (applying...)` : config.title}
        footer={<micaUi.KeyHints hints={isApplying ? ['applying'] : ['↑↓ navigate', '↵ select', 'esc cancel']} />}
      >
        <micaUi.SelectList
          items={items}
          selectedIdx={currentIdx}
          empty={<Text dimColor>{config.emptyMessage ?? 'no options'}</Text>}
          itemGap={1}
        />
      </micaUi.Dialog>
    );
  }

  micaUi.panels.setPluginUIs([
    {
      id: config.id,
      component: SelectorPanel,
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
        if (key.upArrow || key.downArrow) {
          const direction = key.upArrow ? -1 : 1;
          const len = config.options.length;
          if (len > 0) {
            selectedIdx.set((selectedIdx.get() + direction + len) % len);
          }
          return true;
        }
        return false;
      },
    },
  ]);
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
          <micaUi.SelectList
            items={items}
            selectedIdx={currentIdx}
            itemGap={1}
          />
        </micaUi.Dialog>
      );
    }

    micaUi.panels.setPluginUIs([
      {
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
          if (key.upArrow || key.downArrow) {
            const current = selectedIdx.get();
            selectedIdx.set(current === yesIdx ? noIdx : yesIdx);
            return true;
          }
          return false;
        },
      },
    ]);
  });
}
