import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { UIPanelPlugin } from '../MicaPlugin';
import { model } from '../../store/config.js';
import { useScheduleState } from '../../components/ui/hooks/useScheduleState.js';

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
    return (
      <Box paddingX={1}>
        <Text dimColor>no models available</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box paddingBottom={1}>
        <Text dimColor>select model:</Text>
      </Box>
      {models.map((m, i) => {
        const isSelected = i === selected;
        const isActive = m.name === current;
        return (
          <Box key={m.name}>
            <Box flexDirection="row">
              <Box width={2}>
                <Text color={isSelected ? 'claude' : 'inactive'}>
                  {isSelected ? '▶' : ' '}
                </Text>
              </Box>
              <Text color={isSelected ? 'claude' : undefined} bold={isSelected}>
                {m.label}
              </Text>
              {isActive && <Text color="#4CAF50"> (active)</Text>}
            </Box>
          </Box>
        );
      })}
    </Box>
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
