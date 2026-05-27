import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { MicaPlugin } from '../MicaPlugin';
import type { EffortLevel } from '../../store/config.js';
import { model } from '../../store/config.js';
import { useScheduleState } from '../../components/ui/hooks/useScheduleState.js';

interface EffortState {
  selectedIdx: number;
}

function EffortList({
  efforts,
  selected,
  current,
}: {
  efforts: ReadonlyArray<{ name: string; label: string }>;
  selected: number;
  current: string;
}) {
  if (efforts.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>no efforts available</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box paddingBottom={1}>
        <Text dimColor>select effort:</Text>
      </Box>
      {efforts.map((e, i) => {
        const isSelected = i === selected;
        const isActive = e.name === current;
        return (
          <Box key={e.name}>
            <Box flexDirection="row">
              <Box width={2}>
                <Text color={isSelected ? 'claude' : 'inactive'}>
                  {isSelected ? '▶' : ' '}
                </Text>
              </Box>
              <Text color={isSelected ? 'claude' : undefined} bold={isSelected}>
                {e.label}
              </Text>
              {isActive && <Text color="#4CAF50"> (active)</Text>}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function EffortSelector({ state }: { state: EffortState }) {
  const currentEffort = useScheduleState(model.effort);
  const efforts = useScheduleState(model.effortOptions);
  return <EffortList efforts={efforts} selected={state.selectedIdx} current={currentEffort} />;
}

export class QuickCommandEffortPlugin extends MicaPlugin {
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
