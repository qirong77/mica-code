import React from 'react';
import { Box, useTerminalTitle } from '@anthropic/ink';
import { ConversationUI } from '../conversation/Conversation.js';
import { TerminalInputUI } from '../input/TerminalInput.js';
import { WorkingStatusUI } from './WorkingStatus.js';
import { BottomSurface } from '../bottom/BottomSurface.js';
import { MessageBar } from './MessageBar.js';

export function App(): React.ReactNode {
  useTerminalTitle('* Mica Code');

  return (
    <Box flexDirection="column" height="100%">
      <ConversationUI.renderFn />
      <TerminalInputUI.renderFn />
      <WorkingStatusUI.renderFn />
      <MessageBar />
      <Box flexGrow={1}>
        <BottomSurface />
      </Box>
      <Box paddingBottom={1} />
    </Box>
  );
}
