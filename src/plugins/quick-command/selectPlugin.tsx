import React from 'react';
import { Text } from '@anthropic/ink';
import { UIPanelPlugin, handleListKeys } from '../MicaPlugin.js';
import { model } from '../../store/config.js';
import { useScheduleState } from '../../components/hooks/useScheduleState.js';
import { Dialog, SelectList, KeyHints, StatusRow } from '../../components/primitives/index.js';
import { C } from '../../components/data.js';
import type { SelectItem } from '../../components/primitives/index.js';

import type { Command } from '../../store/uiState.js';

interface SelectState {
  selectedIdx: number;
}

export type SelectOptionConfig = {
  name: string;
  description: string;
  title: string;
  getCurrent: () => string;
  getOptions: () => Array<{ name: string; label: string }>;
  onSelect: (value: string) => void;
  emptyMessage?: string;
};

export function createSelectCommand(plugin: UIPanelPlugin, config: SelectOptionConfig): Command {
  return {
    name: config.name,
    description: config.description,
    action: () => {
      const current = config.getCurrent();
      const options = config.getOptions();
      plugin.showUI<SelectState>(
        SelectOptionPanel(config.title, options, current, config.emptyMessage),
        {
          selectedIdx: Math.max(
            0,
            options.findIndex((o) => o.name === current),
          ),
        },
        (_input: string, key: any, state: SelectState, setState: (s: SelectState) => void) =>
          handleListKeys(
            key,
            state,
            setState,
            options.length,
            (idx) => {
              const selected = options[idx];
              if (selected) config.onSelect(selected.name);
              plugin.hideUI();
            },
            () => plugin.hideUI(),
          ),
      );
    },
  };
}

function SelectOptionPanel(
  title: string,
  options: Array<{ name: string; label: string }>,
  current: string,
  emptyMessage?: string,
) {
  return function Selector({ state }: { state: SelectState }) {
    const items: SelectItem[] = options.map((o) => ({
      key: o.name,
      label: o.label,
      suffix: o.name === current ? <Text color={C.success}> (active)</Text> : null,
    }));

    return (
      <Dialog title={title} footer={<KeyHints hints={['↑↓ navigate', '↵ select', 'esc cancel']} />}>
        <SelectList
          items={items}
          selectedIdx={state.selectedIdx}
          empty={emptyMessage ? <StatusRow type="info">{emptyMessage}</StatusRow> : undefined}
        />
      </Dialog>
    );
  };
}

export class QuickCommandModelPlugin extends UIPanelPlugin {
  onInstall(): void {
    this.addQuickCommand(
      createSelectCommand(this, {
        name: 'model',
        description: '切换模型',
        title: 'select model',
        getCurrent: () => this.atoms.model.get(),
        getOptions: () => this.atoms.modelOptions.get(),
        onSelect: (v) => this.atoms.model.set(v),
        emptyMessage: this.atoms.modelOptionsError.get() ?? 'no models available',
      }),
    );
  }
}

export class QuickCommandEffortPlugin extends UIPanelPlugin {
  onInstall(): void {
    this.addQuickCommand(
      createSelectCommand(this, {
        name: 'effort',
        description: '切换推理强度',
        title: 'select effort',
        getCurrent: () => this.atoms.effort.get(),
        getOptions: () => this.atoms.effortOptions.get(),
        onSelect: (v) => this.atoms.effort.set(v as any),
      }),
    );
  }
}
