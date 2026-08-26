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
  subagentTaskItems,
  abortAgent,
  setPluginUIs,
  editPendingInput,
  commandPanelItems,
  loopStatus,
} from '../panels/state.js';
import { pendingInputs } from '../conversation/state.js';
import { DropDownUI } from '../bottom/dropdown/index.js';
import { saveClipboardImage } from '../utils/imagePaste.js';
import { buildLoopBadge } from '../utils/format.js';
import { PromptFrame } from './PromptFrame.js';
import type { DOMElement } from '@anthropic/ink';
import type { TerminalInputQueueMode, TerminalInputSubmitOptions } from './state.js';
import type { PromptFrameMode } from './PromptFrame.js';
import type { MicaUiSubagentTaskItem } from '../types.js';

interface YogaNodeLike {
  getComputedTop(): number;
  getComputedHeight(): number;
}

const EXIT_CONFIRM_TIMEOUT_MS = 2000;
const QUEUE_SHORTCUT_TIP = 'Enter/Tab 等 agent 执行完成后发送，shift + tab 本轮工具调用迭代后发送';
const BASH_MODE_TIP = 'bash · Enter 后台执行';

/** 定时循环运行期间每秒刷新一次，驱动输入框徽标的倒计时。 */
function useLoopCountdown(active: boolean): number {
  const [now, setNow] = useState(Date.now());
  React.useEffect(() => {
    setNow(Date.now());
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

export function hasRunningSubagent(tasks: readonly MicaUiSubagentTaskItem[]): boolean {
  return tasks.some((task) => task.status === 'running');
}

export function shouldIgnoreTerminalTextInput(
  key: any,
  hasDropdownItems: boolean,
  hasInputPlugin: boolean,
): boolean {
  // Input plugins own Enter while their interactive panels are open. A
  // command/file dropdown only owns plain Enter; Shift+Enter still belongs
  // to the multiline editor.
  if (hasInputPlugin) {
    return Boolean(key.escape || key.tab || key.upArrow || key.downArrow || key.return);
  }
  if (key.return && key.shift) return false;
  if (!hasDropdownItems) return false;
  return Boolean(key.escape || key.tab || key.upArrow || key.downArrow || key.return);
}

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
  const [isBashMode, setIsBashMode] = useState(false);
  const terminalSize = useTerminalSize();
  const role = useScheduleState(input.role);
  const rolePrefixWidth = role === 'default' ? 0 : stringWidth(role) + 1;
  const columns = Math.max(1, (process.stdout.columns ?? terminalSize?.columns ?? 80) - 6 - rolePrefixWidth);
  const maxVisibleInputLines = Math.max(1, Math.min(6, Math.floor(terminalSize.rows / 3)));
  const activePluginUIs = useScheduleState(pluginUIs);
  const activeCommandPanelItems = useScheduleState(commandPanelItems);
  const status = useScheduleState(workingStatus);
  const subagentTasks = useScheduleState(subagentTaskItems);
  const placeholder = useScheduleState(input.placeholder);
  const inputDisabled = useScheduleState(input.disabled);
  const currentPendingInputs = useScheduleState(pendingInputs);
  const loop = useScheduleState(loopStatus);
  const loopNow = useLoopCountdown(loop !== null);
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
    !isCommandInput && !isBashMode && !hasActiveInputPlugin && input.hasFileMentionProvider()
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
                label: item.label ?? item.path,
                description: item.description,
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
  const hasInterruptibleWork = isAgentRunning || hasRunningSubagent(subagentTasks);

  const showQueueShortcutTip =
    isAgentRunning &&
    !inputDisabled &&
    !hasActiveInputPlugin &&
    !isCommandInput &&
    !isBashMode &&
    !dropdownVisible &&
    localText.trim().length > 0 &&
    cursorOffset === localText.length;

  const submitValue = useCallback((value: string, options?: TerminalInputSubmitOptions) => {
    const trimmed = value.trim();
    micaConfig.inputHistory.append(options?.bashMode ? `!${trimmed}` : trimmed);
    setHistoryIndex(-1);
    setIsBashMode(false);
    input.text.set('');
    setLocalText('');
    setCursorOffset(0);
    // 提交会绕过 handleChange 直接清空输入框，必须在这里关闭补全下拉，
    // 否则 `no matching commands` 下拉残留导致输入框持续重绘。
    DropDownUI.quickCommand.hide();
    DropDownUI.fileMention.hide();
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

    if (hasInterruptibleWork) {
      clearExitConfirmation();
      abortAgent();
      setLocalText('');
      setCursorOffset(0);
      input.text.set('');
      return;
    }

    armExitConfirmation('Press Ctrl-C again to exit');
  }, [armExitConfirmation, clearExitConfirmation, hasInterruptibleWork]);

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
      // CursorInput's own Tab handler (insert 4 spaces) may still run after
      // this branch with the pre-clear value, re-populating the box with the
      // just-queued message + trailing spaces. That ghost text makes the
      // `localText.length === 0` guard on the shift+left re-edit fail, so the
      // queued message can never be pulled back. Re-clear in a microtask to
      // wipe any such stale synchronous write.
      queueMicrotask(() => {
        input.text.set('');
        setLocalText('');
        setCursorOffset(0);
      });
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

    // 输入分发必须用实时 pluginUIs 而不是 throttle 渲染快照：esc 关闭面板
    // 后，useScheduleState 快照在节流窗口内仍含旧面板，其 onInput 会吞掉
    // 用户紧接着输入的字符（例如 /skills esc 后立即输入 /mcp 被空列表
    // 面板拦截）。
    const livePluginUIs = pluginUIs.get();
    for (const ui of livePluginUIs) {
      if (ui.onInput?.(_input, key)) {
        event?.preventDefault?.();
        event?.stopImmediatePropagation?.();
        if (!ui.preserveInput) {
          input.text.set('');
          setLocalText('');
          setCursorOffset(0);
          DropDownUI.quickCommand.hide();
          DropDownUI.fileMention.hide();
        }
        return;
      }
    }

    const interactivePlugins = livePluginUIs.filter((x) => x.onInput && !x.preserveInput);
    if (interactivePlugins.length > 0 && !key.ctrl && !key.meta && _input) {
      setPluginUIs(livePluginUIs.filter((x) => !x.onInput || x.preserveInput));
      if (_input === '/') {
        setLocalText('/');
        setCursorOffset(1);
        input.text.set('/');
      } else {
        setLocalText('');
        setCursorOffset(0);
        input.text.set('');
        DropDownUI.quickCommand.hide();
        DropDownUI.fileMention.hide();
      }
      return;
    }

    if (key.escape) {
      if (pluginUIs.get().filter((x) => x.onInput).length === 0) {
        setIsBashMode(false);
        setLocalText('');
        setCursorOffset(0);
        input.text.set('');
        DropDownUI.quickCommand.hide();
        DropDownUI.fileMention.hide();
      }
      return;
    }
  });

  const onSubmit = useCallback(
    (value: string) => {
      // 实时读取 pluginUIs：esc 关闭面板后 useScheduleState 快照在节流窗口
      // 内仍含旧面板，若用快照判断会把面板关闭后紧随的 enter 提交吞掉。
      const liveHasInputPlugin = pluginUIs.get().some((ui) => ui.onInput);
      // 下拉框有匹配项时 enter 由下拉框消费；无匹配项（如 unknown command）
      // 时允许提交输入。
      const dropdown = DropDownUI.atomData.dropdown.get();
      if (
        !value.trim() ||
        input.disabled.get() ||
        (dropdown.visible && dropdown.items.length > 0) ||
        liveHasInputPlugin
      )
        return;
      if (isAgentRunning && currentPendingInputs.length > 0) return;
      submitValue(value, isBashMode ? { bashMode: true } : undefined);
    },
    [currentPendingInputs.length, isAgentRunning, isBashMode, submitValue],
  );

  const onExit = useCallback(() => {
    handleCtrlC();
  }, [handleCtrlC]);

  const handleChange = useCallback(
    (value: string) => {
      const entersBashMode = !isBashMode && value.startsWith('!');
      const nextValue = entersBashMode ? value.slice(1) : value;
      if (entersBashMode) {
        setIsBashMode(true);
        setCursorOffset(Math.max(0, cursorOffset - 1));
      }
      setLocalText(nextValue);
      input.text.set(nextValue);
      for (const ui of activePluginUIs) {
        if (ui.onTextChange?.(nextValue)) return;
      }
      if (nextValue.startsWith('/') && nextValue.length >= 1) DropDownUI.quickCommand.show(nextValue.slice(1));
      else DropDownUI.quickCommand.hide();
    },
    [activePluginUIs, cursorOffset, isBashMode],
  );

  const shouldIgnoreTextInput = useCallback(
    (_input: string, key: any) => {
      // 同上：用实时 pluginUIs 判断，避免面板关闭后 enter 被旧快照忽略。
      const liveHasInputPlugin = pluginUIs.get().some((ui) => ui.onInput);
      const dropdown = DropDownUI.atomData.dropdown.get();
      return shouldIgnoreTerminalTextInput(
        key,
        dropdown.visible && dropdown.items.length > 0,
        liveHasInputPlugin,
      );
    },
    [],
  );

  const onHistoryUp = useCallback(() => {
    if (input.disabled.get() || DropDownUI.atomData.dropdown.get().visible || preserveInputOnPluginHandle) return;
    const history = micaConfig.inputHistory.read();
    if (history.length === 0) return;
    const newIndex = historyIndex < history.length - 1 ? historyIndex + 1 : historyIndex;
    if (newIndex !== historyIndex) {
      setHistoryIndex(newIndex);
      const historyValue = history[history.length - 1 - newIndex]!;
      const bashHistory = historyValue.startsWith('!');
      const nextValue = bashHistory ? historyValue.slice(1) : historyValue;
      setIsBashMode(bashHistory);
      setLocalText(nextValue);
      setCursorOffset(nextValue.length);
      input.text.set(nextValue);
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
      const bashHistory = historyValue.startsWith('!');
      const nextValue = bashHistory ? historyValue.slice(1) : historyValue;
      setIsBashMode(bashHistory);
      setLocalText(nextValue);
      setCursorOffset(nextValue.length);
      input.text.set(nextValue);
    } else if (historyIndex === 0) {
      setHistoryIndex(-1);
      setIsBashMode(false);
      setLocalText('');
      setCursorOffset(0);
      input.text.set('');
    }
  }, [historyIndex, preserveInputOnPluginHandle]);

  const loopBadge = loop ? buildLoopBadge(loop.intervalLabel, loop.fireCount, loop.nextFireAt, loopNow) : undefined;
  const baseFrameMode: PromptFrameMode = inputDisabled
    ? 'disabled'
    : isBashMode
      ? 'bash'
      : quickCommandVisible || isCommandInput
        ? 'command'
        : hasActiveInputPlugin
          ? 'plugin'
          : showQueueShortcutTip
            ? 'queue'
            : 'default';
  const frameMode: PromptFrameMode = loopBadge ? 'loop' : baseFrameMode;
  const frameLabel =
    loopBadge ?? (baseFrameMode === 'queue' ? QUEUE_SHORTCUT_TIP : baseFrameMode === 'bash' ? BASH_MODE_TIP : '');

  return (
    <Box flexDirection="column" marginTop={1} ref={setInputBoxRef}>
      <PromptFrame mode={frameMode} label={frameLabel} badge={loopBadge} role={role}>
        <SimpleTextInput
          value={localText}
          onChange={handleChange}
          onSubmit={onSubmit}
          onExit={onExit}
          focus={true}
          multiline={true}
          maxVisibleLines={maxVisibleInputLines}
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
