import { Box, Text, stringWidth, useInput, useTerminalSize } from '@anthropic/ink';
import { micaConfig } from '@packages/mica-config/index.js';
import React from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { SimpleTextInput } from './CursorInput.js';
import { useScheduleState } from '../hooks/index.js';
import * as input from './state.js';
import {
  pluginUIs,
  workingStatus,
  abortAgent,
  setPluginUIs,
  editPendingInput,
  commandPanelItems,
} from '../panels/state.js';
import { pendingInputs } from '../conversation/state.js';
import { DropDownUI } from '../bottom/dropdown/index.js';
import { saveClipboardImage } from '../utils/imagePaste.js';
import { PromptFrame } from './PromptFrame.js';
import type { DOMElement } from '@anthropic/ink';
import type { TerminalInputQueueMode, TerminalInputSubmitOptions } from './state.js';
import type { PromptFrameMode } from './PromptFrame.js';

interface YogaNodeLike {
  getComputedTop(): number;
  getComputedHeight(): number;
}

const EXIT_CONFIRM_TIMEOUT_MS = 2000;
const QUEUE_SHORTCUT_TIP = 'Enter/Tab 等 agent 执行完成后发送，shift + tab 本轮迭代后发送';

function activeFileMention(value: string, cursorOffset: number): { start: number; query: string } | null {
  const beforeCursor = value.slice(0, cursorOffset);
  const match = beforeCursor.match(/@([^\s@]*)$/u);
  if (!match) return null;
  return { start: beforeCursor.length - match[0].length, query: match[1] ?? '' };
}

function mentionPath(path: string): string {
  return /[\s"]/u.test(path) ? JSON.stringify(path) : path;
}

function TerminalInput() {
  const [cursorOffset, setCursorOffset] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const terminalSize = useTerminalSize();
  const role = useScheduleState(input.role);
  const rolePrefixWidth = role === 'default' ? 0 : stringWidth(role) + 1;
  const columns = Math.max(1, (process.stdout.columns ?? terminalSize?.columns ?? 80) - 6 - rolePrefixWidth);
  const activePluginUIs = useScheduleState(pluginUIs);
  const activeCommandPanelItems = useScheduleState(commandPanelItems);
  const status = useScheduleState(workingStatus);
  const placeholder = useScheduleState(input.placeholder);
  const inputDisabled = useScheduleState(input.disabled);
  const currentPendingInputs = useScheduleState(pendingInputs);
  const inputBoxRef = useRef<DOMElement | null>(null);
  const setInputBoxRef = useCallback((el: DOMElement | null) => {
    inputBoxRef.current = el;
  }, []);
  const exitConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileMentionRequestRef = useRef(0);
  const exitConfirmExpiresAtRef = useRef(0);
  const [exitConfirmText, setExitConfirmText] = useState('');
  const lastCtrlCHandledAtRef = useRef(0);

  const [localText, setLocalText] = useState(input.text.get());

  useLayoutEffect(() => {
    const el = inputBoxRef.current;
    if (!el?.yogaNode || !terminalSize) return;
    const yoga = el.yogaNode as unknown as YogaNodeLike;
    let absoluteTop = yoga.getComputedTop();
    let parent: DOMElement | undefined = el.parentNode;
    while (parent) {
      if (parent.yogaNode) absoluteTop += (parent.yogaNode as unknown as YogaNodeLike).getComputedTop();
      parent = parent.parentNode;
    }
    const bottom = absoluteTop + yoga.getComputedHeight();
    const nextDistance = Math.max(0, terminalSize.rows - bottom);
    if (input.inputBottomDistance.get() !== nextDistance) {
      input.inputBottomDistance.set(nextDistance);
    }
  }, [
    terminalSize?.rows,
    terminalSize?.columns,
    localText,
    cursorOffset,
    placeholder,
    status.type,
    activePluginUIs.length,
    currentPendingInputs.length,
    activeCommandPanelItems.length,
  ]);

  const preserveInputOnPluginHandle = activePluginUIs.some((ui) => ui.preserveInput);
  const hasActiveInputPlugin = activePluginUIs.some((ui) => ui.onInput);
  const isCommandInput = localText.trimStart().startsWith('/');
  const dropdown = useScheduleState(DropDownUI.atomData.dropdown);
  const dropdownVisible = dropdown.visible;
  const fileMentionVisible = dropdownVisible && dropdown.kind === 'file';
  const quickCommandVisible = dropdownVisible && !fileMentionVisible;
  const selectedQuickCommand = dropdown.items[dropdown.selectedIndex];
  const quickCommandSuggestion =
    quickCommandVisible && selectedQuickCommand?.insertText?.startsWith(localText)
      ? selectedQuickCommand.insertText
      : undefined;
  const fileMention =
    !isCommandInput && !hasActiveInputPlugin && input.hasFileMentionProvider()
      ? activeFileMention(localText, cursorOffset)
      : null;

  React.useEffect(() => {
    return DropDownUI.onSelect((item) => {
      if (!item.insertText) return;
      const nextText = item.insertText;
      input.text.set(nextText);
      setLocalText(nextText);
      setCursorOffset(item.cursorOffset ?? nextText.length);
      if (item.kind === 'file') DropDownUI.fileMention.hide();
      else if (nextText.startsWith('/')) DropDownUI.quickCommand.show(nextText.slice(1));
      else DropDownUI.quickCommand.hide();
    });
  }, []);

  React.useEffect(() => {
    const request = ++fileMentionRequestRef.current;
    if (!fileMention) {
      DropDownUI.fileMention.hide();
      return;
    }

    DropDownUI.fileMention.showLoading();
    const timer = setTimeout(
      () => {
        void input
          .findFileMentions(fileMention.query)
          .then((items) => {
            if (request !== fileMentionRequestRef.current) return;
            const dropdownItems = items.map((item) => {
              const inserted = `@${mentionPath(item.path)} `;
              const insertText = localText.slice(0, fileMention.start) + inserted + localText.slice(cursorOffset);
              return {
                key: `file:${item.path}`,
                label: item.path,
                labelHighlights: item.labelHighlights,
                insertText,
                cursorOffset: fileMention.start + inserted.length,
                kind: 'file' as const,
              };
            });
            DropDownUI.fileMention.show(dropdownItems);
          })
          .catch(() => {
            if (request === fileMentionRequestRef.current) DropDownUI.fileMention.showError();
          });
      },
      fileMention.query ? 100 : 0,
    );

    return () => {
      clearTimeout(timer);
      if (fileMentionRequestRef.current === request) fileMentionRequestRef.current += 1;
    };
  }, [cursorOffset, fileMention?.query, fileMention?.start, localText]);

  React.useEffect(() => {
    return input.text.subscribe((text) => {
      setLocalText(text);
      setCursorOffset(text.length);
    });
  }, []);

  const clearExitConfirmation = useCallback(() => {
    exitConfirmExpiresAtRef.current = 0;
    if (exitConfirmTimerRef.current) {
      clearTimeout(exitConfirmTimerRef.current);
      exitConfirmTimerRef.current = null;
    }
    setExitConfirmText('');
  }, []);

  React.useEffect(() => clearExitConfirmation, [clearExitConfirmation]);

  const isAgentRunning =
    status.type === 'connecting' ||
    status.type === 'thinking' ||
    status.type === 'streaming' ||
    status.type === 'calling_tool';

  const showQueueShortcutTip =
    isAgentRunning &&
    !inputDisabled &&
    !hasActiveInputPlugin &&
    !isCommandInput &&
    !dropdownVisible &&
    localText.trim().length > 0 &&
    cursorOffset === localText.length;

  const submitValue = useCallback((value: string, options?: TerminalInputSubmitOptions) => {
    const trimmed = value.trim();
    micaConfig.inputHistory.append(trimmed);
    setHistoryIndex(-1);
    input.text.set('');
    setLocalText('');
    setCursorOffset(0);
    input.submit(trimmed, options);
  }, []);

  const queueCurrentInput = useCallback(
    (queueMode: TerminalInputQueueMode) => {
      if (!showQueueShortcutTip || currentPendingInputs.length > 0) return;
      submitValue(localText, { queueMode });
    },
    [currentPendingInputs.length, localText, showQueueShortcutTip, submitValue],
  );

  const armExitConfirmation = useCallback(
    (text: string) => {
      clearExitConfirmation();
      exitConfirmExpiresAtRef.current = Date.now() + EXIT_CONFIRM_TIMEOUT_MS;
      setExitConfirmText(text);
      exitConfirmTimerRef.current = setTimeout(() => {
        setExitConfirmText('');
        exitConfirmTimerRef.current = null;
        exitConfirmExpiresAtRef.current = 0;
      }, EXIT_CONFIRM_TIMEOUT_MS);
    },
    [clearExitConfirmation],
  );

  const handleCtrlC = useCallback(() => {
    const now = Date.now();
    if (now - lastCtrlCHandledAtRef.current < 50) return;
    lastCtrlCHandledAtRef.current = now;

    if (exitConfirmExpiresAtRef.current > now) {
      clearExitConfirmation();
      void input.requestExit();
      return;
    }

    if (isAgentRunning) {
      clearExitConfirmation();
      abortAgent();
      setLocalText('');
      setCursorOffset(0);
      input.text.set('');
      return;
    }

    armExitConfirmation('Press Ctrl-C again to exit');
  }, [armExitConfirmation, clearExitConfirmation, isAgentRunning]);

  useInput((_input, key, event) => {
    if (key.ctrl && (_input === '\x03' || _input === '' || _input === 'c')) {
      handleCtrlC();
      return;
    }

    const liveDropdown = DropDownUI.atomData.dropdown.get();
    if (liveDropdown.visible && DropDownUI.quickCommand.handleKey(key)) {
      if (liveDropdown.kind === 'file' && key.escape) fileMentionRequestRef.current += 1;
      event?.preventDefault?.();
      event?.stopImmediatePropagation?.();
      if (!DropDownUI.atomData.dropdown.get().visible && liveDropdown.kind !== 'file') {
        setLocalText('');
        setCursorOffset(0);
        input.text.set('');
      }
      return;
    }

    if (key.tab && showQueueShortcutTip) {
      event?.preventDefault?.();
      event?.stopImmediatePropagation?.();
      queueCurrentInput(key.shift ? 'after_iteration' : 'after_turn');
      return;
    }

    if (key.tab && key.shift && !hasActiveInputPlugin && !dropdownVisible) {
      event?.preventDefault?.();
      event?.stopImmediatePropagation?.();
      input.cycleRole();
      return;
    }

    if (key.shift && key.leftArrow && localText.length === 0 && !hasActiveInputPlugin) {
      const pendingInput = editPendingInput();
      if (pendingInput) {
        setLocalText(pendingInput);
        setCursorOffset(pendingInput.length);
        input.text.set(pendingInput);
      }
      return;
    }

    if (event?.keypress?.isPasted && _input.length === 0) {
      const imagePath = saveClipboardImage();
      if (imagePath) {
        const ref = `[Image](${imagePath})`;
        const newText = localText.slice(0, cursorOffset) + ref + localText.slice(cursorOffset);
        setLocalText(newText);
        setCursorOffset(cursorOffset + ref.length);
        input.text.set(newText);
        return;
      }
    }

    if ((key.ctrl || key.meta) && (_input === '\x16' || _input === 'v')) {
      const imagePath = saveClipboardImage();
      if (imagePath) {
        const ref = `[Image](${imagePath})`;
        const newText = localText.slice(0, cursorOffset) + ref + localText.slice(cursorOffset);
        setLocalText(newText);
        setCursorOffset(cursorOffset + ref.length);
        input.text.set(newText);
        return;
      }
    }

    for (const ui of activePluginUIs) {
      if (ui.onInput?.(_input, key)) {
        event?.preventDefault?.();
        event?.stopImmediatePropagation?.();
        if (!ui.preserveInput) {
          input.text.set('');
          setLocalText('');
          setCursorOffset(0);
        }
        return;
      }
    }

    const interactivePlugins = activePluginUIs.filter((x) => x.onInput && !x.preserveInput);
    if (interactivePlugins.length > 0 && !key.ctrl && !key.meta && _input) {
      setPluginUIs(activePluginUIs.filter((x) => !x.onInput || x.preserveInput));
      if (_input === '/') {
        setLocalText('/');
        setCursorOffset(1);
        input.text.set('/');
      } else {
        setLocalText('');
        setCursorOffset(0);
        input.text.set('');
      }
      return;
    }

    if (key.escape) {
      if (activePluginUIs.filter((x) => x.onInput).length === 0) {
        setLocalText('');
        setCursorOffset(0);
        input.text.set('');
      }
      return;
    }
  });

  const onSubmit = useCallback(
    (value: string) => {
      if (!value.trim() || input.disabled.get() || DropDownUI.atomData.dropdown.get().visible || hasActiveInputPlugin)
        return;
      if (isAgentRunning && currentPendingInputs.length > 0) return;
      submitValue(value);
    },
    [currentPendingInputs.length, hasActiveInputPlugin, isAgentRunning, submitValue],
  );

  const onExit = useCallback(() => {
    handleCtrlC();
  }, [handleCtrlC]);

  const handleChange = useCallback(
    (value: string) => {
      setLocalText(value);
      input.text.set(value);
      for (const ui of activePluginUIs) {
        if (ui.onTextChange?.(value)) return;
      }
      if (value.startsWith('/') && value.length >= 1) DropDownUI.quickCommand.show(value.slice(1));
      else DropDownUI.quickCommand.hide();
    },
    [activePluginUIs],
  );

  const shouldIgnoreTextInput = useCallback(
    (_input: string, key: any) => {
      if (!DropDownUI.atomData.dropdown.get().visible && !hasActiveInputPlugin) return false;
      return Boolean(key.escape || key.tab || key.upArrow || key.downArrow || key.return);
    },
    [hasActiveInputPlugin],
  );

  const onHistoryUp = useCallback(() => {
    if (input.disabled.get() || DropDownUI.atomData.dropdown.get().visible || preserveInputOnPluginHandle) return;
    const history = micaConfig.inputHistory.read();
    if (history.length === 0) return;
    const newIndex = historyIndex < history.length - 1 ? historyIndex + 1 : historyIndex;
    if (newIndex !== historyIndex) {
      setHistoryIndex(newIndex);
      const historyValue = history[history.length - 1 - newIndex]!;
      setLocalText(historyValue);
      setCursorOffset(historyValue.length);
      input.text.set(historyValue);
    }
  }, [historyIndex, preserveInputOnPluginHandle]);

  const onHistoryDown = useCallback(() => {
    if (input.disabled.get() || DropDownUI.atomData.dropdown.get().visible || preserveInputOnPluginHandle) return;
    const history = micaConfig.inputHistory.read();
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      const historyValue = history[history.length - 1 - newIndex];
      if (!historyValue) return;
      setLocalText(historyValue);
      setCursorOffset(historyValue.length);
      input.text.set(historyValue);
    } else if (historyIndex === 0) {
      setHistoryIndex(-1);
      setLocalText('');
      setCursorOffset(0);
      input.text.set('');
    }
  }, [historyIndex, preserveInputOnPluginHandle]);

  const frameMode: PromptFrameMode = inputDisabled
    ? 'disabled'
    : quickCommandVisible || isCommandInput
      ? 'command'
      : hasActiveInputPlugin
        ? 'plugin'
        : showQueueShortcutTip
          ? 'queue'
          : 'default';
  const frameLabel = frameMode === 'queue' ? QUEUE_SHORTCUT_TIP : '';

  return (
    <Box flexDirection="column" marginTop={1} ref={setInputBoxRef}>
      <PromptFrame mode={frameMode} label={frameLabel} role={role}>
        <SimpleTextInput
          value={localText}
          onChange={handleChange}
          onSubmit={onSubmit}
          onExit={onExit}
          focus={true}
          multiline={true}
          placeholder={placeholder}
          columns={columns}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          onHistoryUp={onHistoryUp}
          onHistoryDown={onHistoryDown}
          showCursor={!inputDisabled}
          shouldIgnoreInput={shouldIgnoreTextInput}
          suggestion={quickCommandSuggestion}
        />
      </PromptFrame>
      {exitConfirmText ? (
        <Box paddingLeft={2}>
          <Text dimColor>{exitConfirmText}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export const TerminalInputUI = {
  renderFn: TerminalInput,
  ...input,
};
