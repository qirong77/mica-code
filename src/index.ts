#!/usr/bin/env bun

import dotenv from 'dotenv';
import React from 'react';
import { resolve } from 'node:path';
import { wrappedRender } from '@anthropic/ink';
import { micaUI, App } from '../packages/mica-ui/index.js';
import { AgentRuntime } from './agent/AgentRuntime.js';
import { initMcp } from './mcp/index.js';
import { bootstrap, reportRuntimeError, syncModelDisplay } from './bootstrap.js';
import { registerCommands } from './plugins/index.js';
import { SessionController } from './session/SessionController.js';
import { loadMissingProviderModels } from './store/index.js';

process.on('uncaughtException', (error) => {
  reportRuntimeError(error, '未捕获异常');
});

process.on('unhandledRejection', (error) => {
  reportRuntimeError(error, '未处理的异步错误');
});

dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(process.cwd(), 'packages/agent/.env') });

const app = await wrappedRender(React.createElement(App), {
  exitOnCtrlC: false,
});

try {
  const agent = new AgentRuntime();
  const sessionController = new SessionController(agent);

  registerCommands({ agent, sessionController });
  bootstrap({
    agent,
    sessionController,
    onConfigChanged: () => syncModelDisplay(agent),
  });

  void loadMissingProviderModels().then(() => {
    agent.reloadConfig(false);
    syncModelDisplay(agent);
  });
  micaUI.terminalInput.setPlaceholder('Type a message to start a conversation');
  void initMcp().catch((error) => {
    reportRuntimeError(error, 'MCP 初始化失败');
  });
} catch (error) {
  micaUI.terminalInput.setPlaceholder('Fix the startup error and restart Mica Code');
  reportRuntimeError(error, '启动失败');
}

await app.waitUntilExit();
