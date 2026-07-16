declare module '@anthropic/ink' {
  import type { ReactNode, ComponentType } from 'react';

  interface InkBoxProps {
    children?: ReactNode;
    ref?: any;
    flexDirection?: 'row' | 'column' | 'column-reverse' | 'row-reverse';
    paddingY?: number;
    paddingX?: number;
    paddingLeft?: number;
    paddingRight?: number;
    paddingTop?: number;
    paddingBottom?: number;
    padding?: number;
    margin?: number;
    marginY?: number;
    marginX?: number;
    marginTop?: number;
    marginBottom?: number;
    marginLeft?: number;
    marginRight?: number;
    flexGrow?: number;
    flexShrink?: number;
    flexBasis?: number | string;
    gap?: number;
    width?: number | string;
    height?: number | string;
    minWidth?: number | string;
    minHeight?: number | string;
    borderStyle?: 'single' | 'double' | 'round' | 'bold' | 'singleDouble' | 'doubleSingle' | 'classic';
    borderColor?: string;
    borderLeft?: boolean;
    borderRight?: boolean;
    borderBottom?: boolean;
    borderTop?: boolean;
    alignSelf?: 'flex-start' | 'flex-end' | 'center' | 'stretch';
    justifyContent?: 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around';
    alignItems?: 'flex-start' | 'flex-end' | 'center' | 'stretch';
    overflowX?: 'hidden' | 'visible' | 'scroll';
    overflowY?: 'hidden' | 'visible' | 'scroll';
    position?: 'absolute' | 'relative';
    top?: number;
    left?: number;
    [key: string]: unknown;
  }
  export const Box: ComponentType<InkBoxProps>;
  export const AlternateScreen: ComponentType<{ children?: ReactNode; mouseTracking?: boolean }>;

  interface InkTextProps {
    children?: ReactNode;
    color?: string;
    backgroundColor?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    dimColor?: boolean;
    inverse?: boolean;
    wrap?: 'wrap' | 'truncate' | 'truncate-start' | 'truncate-middle' | 'truncate-end';
    [key: string]: unknown;
  }
  export const Text: ComponentType<InkTextProps>;

  interface AnsiProps {
    children: string;
    dimColor?: boolean;
  }
  export const Ansi: ComponentType<AnsiProps>;

  // DOMElement — yoga node access
  interface YogaNode {
    getComputedTop(): number;
    getComputedHeight(): number;
    getComputedLeft(): number;
    getComputedWidth(): number;
  }
  export interface DOMElement {
    yogaNode: YogaNode | null;
    parentNode: DOMElement | undefined;
    [key: string]: unknown;
  }

  export interface Key {
    name: string;
    ctrl: boolean;
    meta: boolean;
    shift: boolean;
    sequence: string;
    escape?: boolean;
    tab?: boolean;
    return?: boolean;
    backspace?: boolean;
    delete?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    upArrow?: boolean;
    downArrow?: boolean;
    home?: boolean;
    end?: boolean;
  }
  export function useInput(
    inputHandler: (input: string, key: Key, event?: any) => void,
    options?: { isActive?: boolean },
  ): void;
  export function useTerminalSize(): { columns: number; rows: number };
  export function useTerminalFocus(): boolean;
  export function useDeclaredCursor(opts: { line: number; column: number; active: boolean }): Ref<any>;
  export function stringWidth(text: string): number;
  export function wrapAnsi(
    text: string,
    width: number,
    options?: { hard?: boolean; trim?: boolean; wordWrap?: boolean },
  ): string;
  export function wrappedRender(
    node: ReactNode,
    options?: { patchConsole?: boolean; exitOnCtrlC?: boolean; debug?: boolean },
  ): { unmount: () => void; waitUntilExit: () => Promise<void> };

  // ScrollBox
  export interface ScrollBoxHandle {
    getScrollTop(): number;
    scrollTo(pos: number): void;
  }
  interface ScrollBoxProps {
    children?: ReactNode;
    ref?: Ref<ScrollBoxHandle>;
    height?: number;
    stickyScroll?: boolean;
    flexDirection?: 'row' | 'column';
    flexGrow?: number;
    [key: string]: unknown;
  }
  export const ScrollBox: ComponentType<ScrollBoxProps>;

  // Render alternatives
  export function createRoot(options?: {
    exitOnCtrlC?: boolean;
    debug?: boolean;
  }): Promise<{ render(node: ReactNode): void; unmount(): void; waitUntilExit(): Promise<void> }>;
  export function useTerminalTitle(title: string | null): void;
  export function setClipboard(text: string): Promise<string>;
}
