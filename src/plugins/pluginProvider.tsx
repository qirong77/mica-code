import React from "react";
import { Text } from "@anthropic/ink";
import { micaUI } from "../../packages/mica-ui/index.js";
import type { AgentRuntime } from "../agent/AgentRuntime.js";
import { showMessage, syncModelDisplay } from "../bootstrap.js";
import {
  CONFIG_PATH,
  getConfig,
  loadProviderModels,
  updateConfig,
} from "../store/index.js";
import { showSelectCommand } from "./selectCommand.js";

export function registerProviderPlugin(agent: AgentRuntime) {
  return {
    name: "provider",
    description: "切换 AI 服务提供商",
    action: () => {
      const config = getConfig();
      showSelectCommand({
        id: "select-provider",
        title: "select provider" + " (" + CONFIG_PATH + ")",
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
          if (providerId === getConfig().provider) return;
          const next = updateConfig((config) => {
            const provider = config.providers.find((item) => item.id === providerId);
            if (!provider) {
              throw new Error(`Provider not found: ${providerId}`);
            }
            return {
              ...config,
              provider: provider.id,
              model: provider.models?.[0] || provider.model,
              effort: provider.supportsEffort === false ? "none" : provider.effort,
              contextWindowSize: provider.contextWindowSize,
            };
          });
          const provider = next.providers.find((item) => item.id === providerId);
          if (provider?.get_model_url && !provider.models?.length) {
            void loadProviderModels(providerId).then(() => {
              agent.reloadConfig(false);
              syncModelDisplay(agent);
            });
          }
          agent.reloadConfig();
          syncModelDisplay(agent);
          showMessage(`Provider: ${next.provider}`, 3000);
        },
      });
    },
  } satisfies Parameters<typeof micaUI.dropdown.setQuickCommands>[0][number];
}
