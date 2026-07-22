import React from 'react';
import { Box, useTerminalSize } from '@anthropic/ink';
import { ConversationUI } from '../conversation/Conversation.js';
import { TerminalInputUI } from '../input/TerminalInput.js';
import { WorkingStatusUI } from '../panels/WorkingStatus.js';
import { BottomSurface } from '../bottom/BottomSurface.js';
import { MessageBar } from '../panels/MessageBar.js';
import { TaskStatusBar } from '../panels/TaskStatusBar.js';
import { CommandPanelUI } from '../panels/CommandPanel.js';
import { TerminalTitle } from './TerminalTitle.js';
import { getMainScreenHeight } from './mainScreenLayout.js';
// import { StartupBannerUI } from './StartupBanner.js';

export function App(): React.ReactNode {
  const { rows } = useTerminalSize();

  return (
    <Box flexDirection="column" minHeight={getMainScreenHeight(rows)} flexShrink={0}>
      <TerminalTitle />
      {/* <StartupBannerUI.renderFn /> */}
      <ConversationUI.renderFn />
      <TaskStatusBar />
      <CommandPanelUI.renderFn />
      <TerminalInputUI.renderFn />
      <WorkingStatusUI.renderFn />
      <MessageBar />
      <Box flexGrow={1}>
        <BottomSurface />
      </Box>
      {/* <Box paddingBottom={1} /> */}
    </Box>
  );
}
