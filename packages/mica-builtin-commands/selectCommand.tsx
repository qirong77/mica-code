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
  onSelect: (name: string) => void;
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

  function hide() {
    micaLogger.logRuntime('plugin.select', 'closed', { id: config.id, title: config.title });
    micaUi.panels.clearPluginUIs();
  }

  function selectCurrent() {
    const selected = config.options[selectedIdx.get()];
    if (selected) {
      micaLogger.logRuntime('plugin.select', 'selected', { id: config.id, title: config.title, value: selected.name });
      config.onSelect(selected.name);
    } else {
      micaLogger.logRuntime('plugin.select', 'select:empty', { id: config.id, title: config.title }, 'warn');
    }
    hide();
  }

  function SelectorPanel() {
    const currentIdx = micaUi.useScheduleState(selectedIdx);
    const items: SelectItem[] = config.options.map((option) => ({
      key: option.name,
      label: option.label,
      suffix: option.name === config.current ? <Text color={micaUi.theme.colors.success}> (active)</Text> : undefined,
    }));

    return (
      <micaUi.Dialog title={config.title} footer={<micaUi.KeyHints hints={['↑↓ navigate', '↵ select', 'esc cancel']} />}>
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
