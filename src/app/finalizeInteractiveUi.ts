import React, { type ReactNode } from 'react';
import { micaUi } from '@packages/mica-ui/index.js';

type InteractiveRenderInstance = {
  rerender(node: ReactNode): void;
  unmount(): void;
};

/**
 * Preserve only conversation history when leaving Ink's main-screen renderer.
 * Ink keeps its final frame in terminal scrollback, so unmounting the complete
 * app would otherwise leave the input and status UI above the shell prompt.
 */
export function finalizeInteractiveUi(renderInstance: InteractiveRenderInstance | null): void {
  if (!renderInstance) return;
  renderInstance.rerender(React.createElement(micaUi.Conversation));
  renderInstance.unmount();
}
