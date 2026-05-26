import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { MicaPlugin } from '../MicaPlugin';
import type { EffortLevel } from '../../store/config.js';

function EffortList({
  efforts,
  selected,
  current,
}: {
  efforts: Array<{ name: string; label: string }>;
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
      {efforts.map((e, i) => (
        <Box key={e.name}>
          <Text color={i === selected ? 'claude' : 'inactive'}>
            {e.label}
          </Text>
          {e.name === current && (
            <Text color="#4CAF50"> (active)</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

export class QuickCommandEffortPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'effort',
      description: '切换推理强度',
      action: () => {
        const currentEffort = this.atoms.effort.get();
        const efforts = this.atoms.effortOptions.get();

        const ctx = {
          efforts,
          selectedIdx: Math.max(0, efforts.findIndex((e) => e.name === currentEffort)),
          render: null as any,
          onInput: null as any,
        };

        ctx.render = () => (
          <EffortList
            efforts={ctx.efforts}
            selected={ctx.selectedIdx}
            current={currentEffort}
          />
        );

        ctx.onInput = (_input: string, key: any) => {
          if (key.upArrow) {
            ctx.selectedIdx =
              ctx.selectedIdx > 0 ? ctx.selectedIdx - 1 : ctx.efforts.length - 1;
            this.showUI(ctx.render, ctx.onInput);
            return true;
          }
          if (key.downArrow) {
            ctx.selectedIdx =
              ctx.selectedIdx < ctx.efforts.length - 1 ? ctx.selectedIdx + 1 : 0;
            this.showUI(ctx.render, ctx.onInput);
            return true;
          }
          if (key.return) {
            this.atoms.effort.set(ctx.efforts[ctx.selectedIdx]!.name as EffortLevel);
            this.hideUI();
            return true;
          }
          if (key.escape) {
            this.hideUI();
            return true;
          }
          return false;
        };

        this.showUI(ctx.render, ctx.onInput);
      },
    });
  }
}
