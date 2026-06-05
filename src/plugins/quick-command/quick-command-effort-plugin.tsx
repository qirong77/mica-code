import React from 'react';
import { Text } from '@anthropic/ink';
import { UIPanelPlugin } from '../MicaPlugin';
import type { EffortLevel } from '../../store/config.js';
import { model } from '../../store/config.js';
import { useScheduleState } from '../../components/ui/hooks/useScheduleState.js';
import { Dialog, SelectList, KeyHints } from '../../components/ui/primitives/index.js';
import { C } from '../../components/ui/data.js';
import type { SelectItem } from '../../components/ui/primitives/index.js';

interface EffortState {
  selectedIdx: number;
}

function EffortSelector({ state }: { state: EffortState }) {
  const currentEffort = useScheduleState(model.effort);
  const efforts = useScheduleState(model.effortOptions);

  const items: SelectItem[] = efforts.map((e) => ({
    key: e.name,
    label: e.label,
    suffix: e.name === currentEffort ? <Text color={C.success}> (active)</Text> : null,
  }));

  return (
    <Dialog title="select effort" footer={<KeyHints hints={['↑↓ navigate', '↵ select', 'esc cancel']} />}>
      <SelectList items={items} selectedIdx={state.selectedIdx} />
    </Dialog>
  );
}

export class QuickCommandEffortPlugin extends UIPanelPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'effort',
      description: '切换推理强度',
      action: () => {
        const currentEffort = this.atoms.effort.get();
        const efforts = this.atoms.effortOptions.get();

        this.showUI<EffortState>(
          EffortSelector,
          { selectedIdx: Math.max(0, efforts.findIndex((e) => e.name === currentEffort)) },
          (_input, key, state, setState) => {
            if (key.upArrow) {
              setState({ selectedIdx: state.selectedIdx > 0 ? state.selectedIdx - 1 : efforts.length - 1 });
              return true;
            }
            if (key.downArrow) {
              setState({ selectedIdx: state.selectedIdx < efforts.length - 1 ? state.selectedIdx + 1 : 0 });
              return true;
            }
            if (key.return) {
              const selected = efforts[state.selectedIdx];
              if (selected) this.atoms.effort.set(selected.name as EffortLevel);
              this.hideUI();
              return true;
            }
            if (key.escape) {
              this.hideUI();
              return true;
            }
            return false;
          },
        );
      },
    });
  }
}