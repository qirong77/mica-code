import { Box, Text, useInput, useTerminalSize } from '@anthropic/ink';
import { micaConfig } from '@packages/mica-config/index.js';
import React from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { SimpleTextInput } from './CursorInput.js';
import { themeColors } from '../theme.js';
import { useScheduleState } from '../hooks/index.js';
import * as input from './state.js';
import { pluginUIs, workingStatus, abortAgent, setPluginUIs, editPendingInput } from '../panels/state.js';
import { pendingInputs, pendingQueueMode } from '../conversation/state.js';
import { DropDownUI } from '../bottom/dropdown/index.js';
import { MessageBarAPI } from '../panels/MessageBar.js';
import { saveClipboardImage } from '../utils/imagePaste.js';
import type { DOMElement } from '@anthropic/ink';
import type { TerminalInputQueueMode, TerminalInputSubmitOptions } from './state.js';

interface YogaNodeLike {
  getComputedTop(): number;
  getComputedHeight(): number;
}

const EXIT_CONFIRM_TIMEOUT_MS = 800;

function formatPendingStatusText(queueMode: ReturnType<typeof pendingQueueMode.get>): string {
  if (queueMode === 'after_turn') return '已排队，等待当前 agent 执行完成后发送';
  if (queueMode === 'after_iteration') return '已排队，等待当前 agent 本轮迭代完成后发送';
  return '已排队，等待当前 agent 可继续时发送';
}

function TerminalInput() {
  const [cursorOffset, setCursorOffset] = useState(0);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const terminalSize = useTerminalSize();
  const columns = Math.max(1, (process.stdout.columns ?? terminalSize?.columns ?? 80) - 6);
  const activePluginUIs = useScheduleState(pluginUIs);
  const status = useScheduleState(workingStatus);
  const placeholder = useScheduleState(input.placeholder);
  const inputDisabled = useScheduleState(input.disabled);
  const currentPendingInputs = useScheduleState(pendingInputs);
  const currentPendingQueueMode = useScheduleState(pendingQueueMode);
  const inputBoxRef = useRef<DOMElement | null>(null);
  const setInputBoxRef = useCallback((el: DOMElement | null) => {
    inputBoxRef.current = el;
  }, []);
  const exitConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitConfirmExpiresAtRef = useRef(0);
  const exitConfirmMessageIdRef = useRef<string | null>(null);
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
    currentPendingQueueMode,
  ]);

  const preserveInputOnPluginHandle = activePluginUIs.some((ui) => ui.preserveInput);
  const hasActiveInputPlugin = activePluginUIs.some((ui) => ui.onInput);
  const isCommandInput = localText.trimStart().startsWith('/');

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
    if (exitConfirmMessageIdRef.current) {
      MessageBarAPI.removeMessage(exitConfirmMessageIdRef.current);
      exitConfirmMessageIdRef.current = null;
    }
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
    localText.trim().length > 0 &&
    cursorOffset === localText.length;

  React.useEffect(() => {
    const nextStatusText =
      currentPendingInputs.length > 0
        ? formatPendingStatusText(currentPendingQueueMode)
        : showQueueShortcutTip
          ? 'Tab 等 agent 执行完成后发送，shift + tab 本轮迭代后发送'
          : '';
    input.setQueueStatusText(nextStatusText);
    return () => {
      if (input.queueStatusText.get() === nextStatusText) input.setQueueStatusText('');
    };
  }, [currentPendingInputs.length, currentPendingQueueMode, showQueueShortcutTip]);

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
      const id = `exit-confirm-${Date.now()}`;
      exitConfirmExpiresAtRef.current = Date.now() + EXIT_CONFIRM_TIMEOUT_MS;
      exitConfirmMessageIdRef.current = id;
      MessageBarAPI.addMessage({ id, text });
      exitConfirmTimerRef.current = setTimeout(() => {
        if (exitConfirmMessageIdRef.current === id) {
          MessageBarAPI.removeMessage(id);
          exitConfirmMessageIdRef.current = null;
        }
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
      process.exit(0);
    }

    if (isAgentRunning) {
      clearExitConfirmation();
      abortAgent();
      setLocalText('');
      setCursorOffset(0);
      input.text.set('');
      return;
    }

    armExitConfirmation('再按一次 Ctrl+C 退出');
  }, [armExitConfirmation, clearExitConfirmation, isAgentRunning]);

  useInput((_input, key, event) => {
    if (key.ctrl && (_input === '\x03' || _input === '' || _input === 'c')) {
      handleCtrlC();
      return;
    }

    if (key.tab && showQueueShortcutTip) {
      event?.preventDefault?.();
      event?.stopImmediatePropagation?.();
      queueCurrentInput(key.shift ? 'after_iteration' : 'after_turn');
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

    if (DropDownUI.quickCommand.handleKey(key)) {
      setLocalText('');
      setCursorOffset(0);
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
      if (!value.trim() || input.disabled.get() || hasActiveInputPlugin) return;
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

  const onHistoryUp = useCallback(() => {
    if (input.disabled.get() || preserveInputOnPluginHandle) return;
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
    if (input.disabled.get() || preserveInputOnPluginHandle) return;
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

  return (
    <Box flexDirection="column" marginTop={1} ref={setInputBoxRef}>
      <Box
        flexDirection="row"
        alignItems="flex-start"
        justifyContent="flex-start"
        borderColor={themeColors.borderInput}
        borderStyle="round"
        borderLeft={false}
        borderRight={false}
        borderBottom
        width="100%"
      >
        <Box marginLeft={1} marginRight={1}>
          <Text bold>{'❯'}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
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
          />
        </Box>
      </Box>
    </Box>
  );
}

export const TerminalInputUI = {
  renderFn: TerminalInput,
  ...input,
};
