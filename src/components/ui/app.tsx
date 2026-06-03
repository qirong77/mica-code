import React from 'react';
import { Box, useTerminalTitle } from '../../../packages/@anthropic/ink/src/index.js';

import { TerminalInputUI } from './components/TerminalInput/TerminalInput.js';
import { ConversationUI } from './components/Conversation/index.js';
import { WorkingStatusUI } from './components/WorkingStatus/index.js';
import { BottomPanel } from './components/BottomPanel/index.js';
import { MessageBar } from './components/MessageBar/index.js';


export function App(): React.ReactNode {
  useTerminalTitle('* Mica Code');

  return (
    <Box flexDirection="column" height="100%">
      <ConversationUI.renderFn />
      <TerminalInputUI.renderFn />
      <WorkingStatusUI.renderFn />
      <MessageBar/>
      <Box flexGrow={1}>
        <BottomPanel />
      </Box>
      <Box paddingBottom={1} />
    </Box>
  );
}
