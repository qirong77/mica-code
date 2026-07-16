import React from 'react';
import { AlternateScreen, Box } from '@anthropic/ink';
import { ConversationUI } from '../conversation/Conversation.js';
import { TerminalInputUI } from '../input/TerminalInput.js';
import { WorkingStatusUI } from '../panels/WorkingStatus.js';
import { BottomSurface } from '../bottom/BottomSurface.js';
import { MessageBar } from '../panels/MessageBar.js';
import { TaskStatusBar } from '../panels/TaskStatusBar.js';
import { CommandPanelUI } from '../panels/CommandPanel.js';
import { TerminalTitle } from './TerminalTitle.js';
// import { StartupBannerUI } from './StartupBanner.js';

export function App(): React.ReactNode {
  return (
    <AlternateScreen mouseTracking={false}>
      <Box flexDirection="column" height="100%">
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
    </AlternateScreen>
  );
}
