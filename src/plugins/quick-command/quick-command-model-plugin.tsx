import React from 'react';
import { Box, Text } from '@anthropic/ink';
import { MicaPlugin } from '../MicaPlugin';

function ModelList({
  models,
  selected,
  current,
}: {
  models: Array<{ name: string; label: string }>;
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
          <Box key={m.name} marginBottom={i < models.length - 1 ? 0 : 0}>
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

export class QuickCommandModelPlugin extends MicaPlugin {
  onInstall(): void {
    this.addQuickCommand({
      name: 'model',
      description: '切换模型',
      action: () => {
        const currentModel = this.atoms.model.get();
        const models = this.atoms.modelOptions.get();

        const ctx = {
          models,
          selectedIdx: Math.max(0, models.findIndex((m) => m.name === currentModel)),
          render: null as any,
          onInput: null as any,
        };

        ctx.render = () => (
          <ModelList
            models={ctx.models}
            selected={ctx.selectedIdx}
            current={currentModel}
          />
        );

        ctx.onInput = (_input: string, key: any) => {
          if (key.upArrow) {
            ctx.selectedIdx =
              ctx.selectedIdx > 0 ? ctx.selectedIdx - 1 : ctx.models.length - 1;
            this.showUI(ctx.render, ctx.onInput);
            return true;
          }
          if (key.downArrow) {
            ctx.selectedIdx =
              ctx.selectedIdx < ctx.models.length - 1 ? ctx.selectedIdx + 1 : 0;
            this.showUI(ctx.render, ctx.onInput);
            return true;
          }
          if (key.return) {
            this.atoms.model.set(ctx.models[ctx.selectedIdx]!.name);
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
