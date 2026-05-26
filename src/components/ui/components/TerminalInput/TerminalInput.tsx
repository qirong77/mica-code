import { Box, Text, useInput } from "@anthropic/ink";
import React from "react";
import { useCallback, useState } from "react";
import { SimpleTextInput } from "./Input";
import { C } from "../../data";
import mitt from 'mitt'
import { useSchedulState } from '../../hooks';
import { terminalInput, pluginUIsAtom } from '../../../../store/ui-state.js';
import { DropDownUI } from '../DropDown/index.js';

type Events = {
  submit: string
}
const emitter = mitt<Events>()

function TerminalInput() {
  const [input, setInput] = useState(terminalInput.text.get());
  const [cursorOffset, setCursorOffset] = useState(0);
  const [prevInputs, setPrevInputs] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const columns = process.stdout.columns - 6;
  const activePluginUIs = useSchedulState(pluginUIsAtom);

  useInput((_input, key) => {
    for (const ui of activePluginUIs) {
      if (ui.onInput?.(_input, key)) {
        setInput('');
        setCursorOffset(0);
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

      // 下拉菜单可见时的 Enter/Tab/Escape 由 useInput → handleDropdownKey 处理，
      // 但 SimpleTextInput 也会触发 onSubmit，这里需要防御
      if (terminalInput.disabled.get()) return;

      const trimmed = value.trim();
      setPrevInputs(prev => [...prev, trimmed]);
      setHistoryIndex(-1);
      setInput('');
      setCursorOffset(0);
      emitter.emit('submit', trimmed);
    },
    [],
  );

  const onExit = useCallback(() => {
    process.exit(0);
  }, []);

  const handleChange = useCallback((value: string) => {
    setInput(value);

    // 检测 '/' 开头 → 委托给 DropDown 模块显示快捷命令列表
    if (value.startsWith('/') && value.length >= 1) {
      const query = value.slice(1);
      DropDownUI.quickCommand.show(query);
    } else {
      DropDownUI.quickCommand.hide();
    }
  }, []);

  const onHistoryUp = useCallback(() => {
    // 下拉菜单可见时，↑↓ 由 useInput → handleDropdownKey 处理
    if (terminalInput.disabled.get()) return;
    if (prevInputs.length === 0) return;
    const newIndex = historyIndex < prevInputs.length - 1 ? historyIndex + 1 : historyIndex;
    if (newIndex !== historyIndex) {
      setHistoryIndex(newIndex);
      const val = prevInputs[prevInputs.length - 1 - newIndex]!;
      setInput(val);
      setCursorOffset(val.length);
    }
  }, [historyIndex, prevInputs]);

  const onHistoryDown = useCallback(() => {
    // 下拉菜单可见时，↑↓ 由 useInput → handleDropdownKey 处理
    if (terminalInput.disabled.get()) return;
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
  }, [historyIndex, prevInputs]);

  // 读取 terminalInput.disabled：下拉菜单可见时禁用光标，并阻止历史/提交回调
  const inputDisabled = useSchedulState(terminalInput.disabled);

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
            placeholder="Type something and press Enter..."
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
  renderFn:TerminalInput,
  emitter,
  atomText: terminalInput.text,
}