#!/usr/bin/env bun

import dotenv from 'dotenv';
import React from 'react';
import { resolve } from 'node:path';
import { wrappedRender } from '@anthropic/ink';
import { micaUI } from '@packages/mica-ui/index.js';
import { AgentRuntime } from './agent/AgentRuntime.js';
import { micaMcp } from '@packages/mica-mcp/index.js';
import { bootstrap, reportRuntimeError, syncModelDisplay } from './app/bootstrap.js';
import { registerCommands } from './commands/index.js';
import { SessionController } from './session/SessionController.js';
import { micaConfig } from '@packages/mica-config/index.js';
import { AgentRegistry } from './agents/agentRegistry.js';

process.on('uncaughtException', (error) => {
  reportRuntimeError(error, '未捕获异常');
});

process.on('unhandledRejection', (error) => {
  reportRuntimeError(error, '未处理的异步错误');
});

dotenv.config({ path: resolve(process.cwd(), '.env') });
dotenv.config({ path: resolve(process.cwd(), 'packages/mica-agent/.env') });

const app = await wrappedRender(React.createElement(micaUI.App), {
  exitOnCtrlC: false,
});
let agentRegistry: AgentRegistry | null = null;

try {
  const agent = new AgentRuntime();
  agentRegistry = new AgentRegistry(agent);
  agentRegistry.start();
  const sessionController = new SessionController(agent);

  registerCommands({ agent, sessionController });
  bootstrap({
    agent,
    sessionController,
    onConfigChanged: () => syncModelDisplay(agent),
  });

  void micaConfig.loadMissingProviderModels().then(() => {
    agent.reloadConfig(false);
    syncModelDisplay(agent);
  });
  micaUI.terminalInput.setPlaceholder('Type a message to start a conversation');
  void micaMcp.init().catch((error) => {
    reportRuntimeError(error, 'MCP 初始化失败');
  });
} catch (error) {
  micaUI.terminalInput.setPlaceholder('Fix the startup error and restart Mica Code');
  reportRuntimeError(error, '启动失败');
}

await app.waitUntilExit();
agentRegistry?.stop();
