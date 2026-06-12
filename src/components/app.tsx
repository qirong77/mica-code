import React from 'react';
import { Box, useTerminalTitle } from '@anthropic/ink';

import { TerminalInputUI } from './input/TerminalInput.js';
import { ConversationUI } from './conversation/Conversation.js';
import { WorkingStatusUI } from './panels/WorkingStatus.js';
import { BottomPanel } from './panels/BottomPanel.js';
import { MessageBar } from './panels/MessageBar.js';
import { AgentTurnLogUI } from './panels/AgentTurnLog.js';

export function App(): React.ReactNode {
  useTerminalTitle('* Mica Code');

  return (
    <Box flexDirection="column" height="100%">
      <ConversationUI.renderFn />

      <TerminalInputUI.renderFn />
      <WorkingStatusUI.renderFn />
      <MessageBar />
      <AgentTurnLogUI.renderFn />
      <Box flexGrow={1}>
        <BottomPanel />
      </Box>
      <Box paddingBottom={1} />
    </Box>
  );
}
