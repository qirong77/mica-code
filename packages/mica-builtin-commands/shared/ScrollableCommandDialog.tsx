import type { ReactNode } from 'react';
import type { ScrollBoxHandle } from '@packages/@anthropic/ink/src/components/ScrollBox.js';
import { micaUi, type BottomScrollBoxProps } from '@packages/mica-ui/index.js';

export type CommandScrollController = {
  ref(handle: ScrollBoxHandle | null): void;
  getViewportHeight(): number;
  scrollBy(offset: number): void;
};

export function createCommandScrollController(): CommandScrollController {
  let handle: ScrollBoxHandle | null = null;
  return {
    ref(nextHandle) {
      handle = nextHandle;
    },
    getViewportHeight() {
      return handle?.getViewportHeight() ?? 10;
    },
    scrollBy(offset) {
      handle?.scrollBy(offset);
    },
  };
}

type ScrollableCommandDialogProps = Omit<BottomScrollBoxProps, 'children' | 'ref'> & {
  title: string;
  controller: CommandScrollController;
  hints: string[];
  children: ReactNode;
};

export function ScrollableCommandDialog({
  title,
  controller,
  hints,
  children,
  ...scrollProps
}: ScrollableCommandDialogProps): ReactNode {
  return (
    <micaUi.Dialog title={title} footer={<micaUi.KeyHints hints={['↑↓/pgup/pgdn scroll', ...hints]} />}>
      <micaUi.BottomScrollBox ref={controller.ref} {...scrollProps}>
        {children}
      </micaUi.BottomScrollBox>
    </micaUi.Dialog>
  );
}
