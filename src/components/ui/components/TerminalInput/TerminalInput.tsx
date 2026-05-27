import { Box, Text, useInput } from "@anthropic/ink";
import React from "react";
import { useCallback, useState } from "react";
import { SimpleTextInput } from "./Input";
import { C } from "../../data";
import mitt from 'mitt'
import { useScheduleState } from '../../hooks';
import { terminalInput, pluginUIsAtom, workingStatusAtom } from '../../../../store/ui-state.js';
import { agentTurn } from '../../../../agent/turn.js';
import { DropDownUI } from '../DropDown/index.js';

type Events = {
  submit: string
}
const emitter = mitt<Events>()

const DOUBLE_PRESS_TIMEOUT_MS = 800

function useDoublePressExit(isIdle: boolean): [boolean, () => void] {
  const [pending, setPending] = useState(false);
  const lastPressRef = React.useRef(0);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout>>();

  const handlePress = useCallback(() => {
    if (!isIdle) return;

    const now = Date.now();
    const timeSince = now - lastPressRef.current;
    const isDouble = timeSince <= DOUBLE_PRESS_TIMEOUT_MS && timeoutRef.current !== undefined;

    if (isDouble) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = undefined;
      setPending(false);
      process.exit(0);
    } else {
      setPending(true);
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        setPending(false);
        timeoutRef.current = undefined;
      }, DOUBLE_PRESS_TIMEOUT_MS);
    }
    lastPressRef.current = now;
  }, [isIdle]);

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  return [pending, handlePress];
}

function TerminalInput() {
  const [input, setInput] = useState(terminalInput.text.get());
  const [cursorOffset, setCursorOffset] = useState(0);
  const [prevInputs, setPrevInputs] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const columns = process.stdout.columns - 6;
  const activePluginUIs = useScheduleState(pluginUIsAtom);
  const workingStatus = useScheduleState(workingStatusAtom);
  const placeholder = useScheduleState(terminalInput.placeholder);

  const preserveInputOnPluginHandle = activePluginUIs.some((ui) => ui.preserveInput);

  React.useEffect(() => {
    return terminalInput.text.listen((text) => {
      setInput(text);
      setCursorOffset(text.length);
    });
  }, []);

  const isAgentRunning = workingStatus.type !== 'idle' && workingStatus.type !== 'completed' && workingStatus.type !== 'error';
  const isAgentIdle = !isAgentRunning;

  const [exitPending, handleExitPress] = useDoublePressExit(isAgentIdle);

  useInput((_input, key) => {
    if (key.ctrl && (_input === '\x03' || _input === '')) {
      if (isAgentRunning) {
        agentTurn.abort();
        setInput('');
        setCursorOffset(0);
        return;
      }
    }

    for (const ui of activePluginUIs) {
      if (ui.onInput?.(_input, key)) {
        if (!ui.preserveInput) {
          terminalInput.text.set('');
          setInput('');
          setCursorOffset(0);
        }
        return;
      }
    }
    if (DropDownUI.quickCommand.handleKey(key)) {
      setInput('');
      setCursorOffset(0);
    }
  });

  const onSubmit = useCallback(
    (value: string) => {
      if (!value.trim()) return;

      if (terminalInput.disabled.get()) return;
      // 仅拦截有 onInput 的交互式插件 UI；showUISimple 等纯展示 UI 不应阻止提交
      if (activePluginUIs.some((ui) => ui.onInput)) return;

      const trimmed = value.trim();
      setPrevInputs(prev => [...prev, trimmed]);
      setHistoryIndex(-1);
      terminalInput.text.set('');
      setInput('');
      setCursorOffset(0);
      emitter.emit('submit', trimmed);
    },
    [activePluginUIs],
  );

  const onExit = useCallback(() => {
    if (isAgentRunning) {
      agentTurn.abort();
      return;
    }
    handleExitPress();
  }, [isAgentRunning, handleExitPress]);

  const handleChange = useCallback((value: string) => {
    setInput(value);
    terminalInput.text.set(value);

    for (const ui of activePluginUIs) {
      if (ui.onTextChange?.(value)) return;
    }

    // 检测 '/' 开头 → 委托给 DropDown 模块显示快捷命令列表
    if (value.startsWith('/') && value.length >= 1) {
      const query = value.slice(1);
      DropDownUI.quickCommand.show(query);
    } else {
      DropDownUI.quickCommand.hide();
    }
  }, [activePluginUIs]);

  const onHistoryUp = useCallback(() => {
    // 下拉菜单可见时，↑↓ 由 useInput → handleDropdownKey 处理
    if (terminalInput.disabled.get() || preserveInputOnPluginHandle) return;
    if (prevInputs.length === 0) return;
    const newIndex = historyIndex < prevInputs.length - 1 ? historyIndex + 1 : historyIndex;
    if (newIndex !== historyIndex) {
      setHistoryIndex(newIndex);
      const val = prevInputs[prevInputs.length - 1 - newIndex]!;
      setInput(val);
      setCursorOffset(val.length);
    }
  }, [historyIndex, prevInputs, preserveInputOnPluginHandle]);

  const onHistoryDown = useCallback(() => {
    // 下拉菜单可见时，↑↓ 由 useInput → handleDropdownKey 处理
    if (terminalInput.disabled.get() || preserveInputOnPluginHandle) return;
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1;
      setHistoryIndex(newIndex);
      const val = prevInputs[prevInputs.length - 1 - newIndex]!;
      setInput(val);
      setCursorOffset(val.length);
    } else if (historyIndex === 0) {
      setHistoryIndex(-1);
      setInput('');
      setCursorOffset(0);
    }
  }, [historyIndex, prevInputs, preserveInputOnPluginHandle]);

  // 读取 terminalInput.disabled：下拉菜单可见时禁用光标，并阻止历史/提交回调
  const inputDisabled = useScheduleState(terminalInput.disabled);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box
        flexDirection="row"
        alignItems="flex-start"
        justifyContent="flex-start"
        borderStyle="round"
        borderLeft={false}
        borderRight={false}
        borderBottom
        width="100%"
      >
        <Box marginLeft={1} marginRight={1}>
          <Text bold color={C.primary}>{'❯'}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <SimpleTextInput
            value={input}
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
      {exitPending && (
        <Box>
          <Text color={C.dim}>Press Ctrl+C again to exit</Text>
        </Box>
      )}
    </Box>
  );
}

export const TerminalInputUI = {
  renderFn: TerminalInput,
  onSubmit: (cb: (text: string) => void) => emitter.on('submit', cb),
  offSubmit: (cb: (text: string) => void) => emitter.off('submit', cb),
  atomText: terminalInput.text,
}