import React from 'react';
import { Text } from '@anthropic/ink';
import { UIPanelPlugin } from '../MicaPlugin';
import { model } from '../../store/config.js';
import { useScheduleState } from '../../components/ui/hooks/useScheduleState.js';
import { Dialog, SelectList, KeyHints, StatusRow } from '../../components/ui/primitives/index.js';
import { C } from '../../components/ui/data.js';
import type { SelectItem } from '../../components/ui/primitives/index.js';

interface ModelState {
  selectedIdx: number;
}

function ModelSelector({ state }: { state: ModelState }) {
  const currentModel = useScheduleState(model.name);
  const models = useScheduleState(model.options);

  const items: SelectItem[] = models.map((m) => ({
    key: m.name,
    label: m.label,
    suffix: m.name === currentModel ? <Text color={C.success}> (active)</Text> : null,
  }));

  return (
    <Dialog title="select model" footer={<KeyHints hints={['↑↓ navigate', '↵ select', 'esc cancel']} />}>
      <SelectList
        items={items}
        selectedIdx={state.selectedIdx}
        empty={<StatusRow type="info">no models available</StatusRow>}
      />
    </Dialog>
  );
}

export class QuickCommandModelPlugin extends UIPanelPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'model',
      description: '切换模型',
      action: () => {
        const currentModel = this.atoms.model.get();
        const models = this.atoms.modelOptions.get();

        this.showUI<ModelState>(
          ModelSelector,
          { selectedIdx: Math.max(0, models.findIndex((m) => m.name === currentModel)) },
          (_input, key, state, setState) => {
            if (key.upArrow) {
              setState({ selectedIdx: state.selectedIdx > 0 ? state.selectedIdx - 1 : models.length - 1 });
              return true;
            }
            if (key.downArrow) {
              setState({ selectedIdx: state.selectedIdx < models.length - 1 ? state.selectedIdx + 1 : 0 });
              return true;
            }
            if (key.return) {
              const selected = models[state.selectedIdx];
              if (selected) this.atoms.model.set(selected.name);
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