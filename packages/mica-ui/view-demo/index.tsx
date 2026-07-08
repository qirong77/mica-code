import React from 'react';
import { Box, useTerminalTitle, wrappedRender } from '@anthropic/ink';
import { ConversationUI } from '../conversation/Conversation.js';
import { TerminalInputUI } from '../input/TerminalInput.js';
import { WorkingStatusUI } from '../panels/WorkingStatus.js';
import { BottomSurface } from '../bottom/BottomSurface.js';
import { MessageBar } from '../panels/MessageBar.js';
import { TaskStatusBar } from '../panels/TaskStatusBar.js';
// import { StartupBannerUI } from './StartupBanner.js';

export function App(): React.ReactNode {
  useTerminalTitle('* Mica Code');

  return (
    <Box flexDirection="column" height="100%" backgroundColor="red">
      {/* <StartupBannerUI.renderFn /> */}
      <ConversationUI.renderFn />
      <TaskStatusBar />
      <TerminalInputUI.renderFn />
    </Box>
  );
}

function Root() {
  return <App />;
}

const instance = await wrappedRender(<Root />);
await instance.waitUntilExit();
