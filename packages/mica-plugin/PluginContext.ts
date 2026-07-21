import type { CommandRegistry } from '@packages/mica-commands/index.js';
import type { RuntimeEventBus, SubmitOptions, SubmitResult } from '@packages/mica-runtime/index.js';
import type { HookRegistry } from './HookRegistry.js';
import type { ServiceContainer } from './ServiceContainer.js';
import type React from 'react';

export type PluginStatusItem = {
  id: string;
  component: React.ComponentType;
};

export type PluginContext = {
  pluginId: string;
  paths?: {
    home: string;
    config: string;
    plugins: string;
  };
  services: ServiceContainer;
  hooks: HookRegistry;
  commands: CommandRegistry;
  events: RuntimeEventBus;
  runtime?: {
    submit(text: string, options?: SubmitOptions): Promise<SubmitResult>;
  };
  ui?: {
    submit(text: string, options?: { displayText?: string }): void;
    showMessage(text: string, ttl?: number): void;
    status?: {
      upsert(item: PluginStatusItem): void;
      remove(id: string): boolean;
    };
    [key: string]: unknown;
  };
  git?: {
    text(args: string[], options?: { timeout?: number }): string;
    formatError(error: unknown): string;
  };
  logger: {
    info(event: string, data?: unknown): void;
    warn(event: string, data?: unknown): void;
    error(event: string, data?: unknown): void;
  };
  onDispose(dispose: () => void | Promise<void>): void;
};
