import React from 'react';
import { Text } from '@anthropic/ink';
import { micaUI } from '@packages/mica-ui/index.js';
import type { AgentRuntime } from '../agent/AgentRuntime.js';
import { showMessage, syncModelDisplay } from '../app/bootstrap.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { showSelectCommand } from './selectCommand.js';
import { logRuntime } from '@packages/mica-logger/index.js';

export function registerProviderPlugin(agent: AgentRuntime) {
  return {
    name: 'provider',
    description: '切换 AI 服务提供商',
    action: () => {
      const config = micaConfig.get();
      logRuntime('plugin.provider', 'opened', {
        current: config.provider,
        providers: config.providers.length,
      });
      showSelectCommand({
        id: 'select-provider',
        title: 'select provider' + ' (' + micaConfig.path + ')',
        current: config.provider,
        options: config.providers.map((provider) => ({
          name: provider.id,
          label: (
            <>
              {provider.name ?? provider.id}
              <Text dimColor>{` (${provider.api_base})`}</Text>
            </>
          ),
        })),
        onSelect: (providerId) => {
          if (providerId === micaConfig.get().provider) {
            logRuntime('plugin.provider', 'selected_current', { provider: providerId });
            return;
          }
          logRuntime('plugin.provider', 'selected', { from: micaConfig.get().provider, to: providerId });
          const next = micaConfig.update((config) => {
            const provider = config.providers.find((item) => item.id === providerId);
            if (!provider) {
              logRuntime('plugin.provider', 'provider:not_found', { provider: providerId }, 'error');
              throw new Error(`Provider not found: ${providerId}`);
            }
            return {
              ...config,
              provider: provider.id,
              model: provider.models?.[0] || provider.model,
              effort: provider.supportsEffort === false ? 'none' : provider.effort,
              contextWindowSize: provider.contextWindowSize,
            };
          });
          const provider = next.providers.find((item) => item.id === providerId);
          if (provider?.get_model_url && !provider.models?.length) {
            logRuntime('plugin.provider', 'models:load:start', { provider: providerId });
            void micaConfig.loadProviderModels(providerId).then(() => {
              agent.reloadConfig(false);
              syncModelDisplay(agent);
              logRuntime('plugin.provider', 'models:load:done', { provider: providerId });
            }).catch((error) => {
              logRuntime('plugin.provider', 'models:load:error', {
                provider: providerId,
                error: error instanceof Error ? error.message : String(error),
              }, 'error');
            });
          }
          agent.reloadConfig();
          syncModelDisplay(agent);
          showMessage(`Provider: ${next.provider}`, 3000);
          logRuntime('plugin.provider', 'applied', {
            provider: next.provider,
            model: next.model,
            effort: next.effort,
          });
        },
      });
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}
