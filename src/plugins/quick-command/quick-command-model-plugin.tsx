import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { UIPanelPlugin } from '../MicaPlugin';
import { model } from '../../store/config.js';
import { useScheduleState } from '../../components/ui/hooks/useScheduleState.js';
import { Panel, StatusRow } from '../../components/ui/primitives/index.js';
import { C } from '../../components/ui/data.js';

interface ModelState {
  selectedIdx: number;
}

function ModelList({
  models,
  selected,
  current,
}: {
  models: ReadonlyArray<{ name: string; label: string }>;
  selected: number;
  current: string;
}) {
  if (models.length === 0) {
    return <StatusRow type="info">no models available</StatusRow>;
  }
  return (
    <Panel header="Model">
      <Box flexDirection="column">
        {models.map((m, i) => {
          const isSelected = i === selected;
          const isActive = m.name === current;
          return (
            <Box key={m.name} flexDirection="row">
              <Box width={2}>
                <Text color={isSelected ? C.accent : undefined}>
                  {isSelected ? '\u25B6' : ' '}
                </Text>
              </Box>
              <Text color={isSelected ? C.accent : undefined} bold={isSelected}>
                {m.label}
              </Text>
              {isActive && <Text color={C.success}> (active)</Text>}
            </Box>
          );
        })}
      </Box>
    </Panel>
  );
}

function ModelSelector({ state }: { state: ModelState }) {
  const currentModel = useScheduleState(model.name);
  const models = useScheduleState(model.options);
  return <ModelList models={models} selected={state.selectedIdx} current={currentModel} />;
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
