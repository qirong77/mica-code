import { Box, Text, useInput, useTerminalSize } from '@anthropic/ink';
import React from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { SimpleTextInput } from "./Input.js";
import { C } from "../data.js";
import mitt from 'mitt'
import { useScheduleState } from '../hooks/index.js';
import { terminalInput, pluginUIsAtom, workingStatusAtom, planModeAtom, inputBottomDistanceAtom } from '../../store/uiState.js';
import { agentTurn } from '../../agent/turn.js';
import { DropDownUI } from '../dropdown/index.js';
import { saveClipboardImage } from '../utils/imagePaste.js';
import { appendSystemLog } from "../../store/logAtom.js";
import { MessageBarAPI } from '../panels/MessageBar.js';
import type { DOMElement } from '@anthropic/ink';

type Events = {
  submit: string
}
const emitter = mitt<Events>()

interface YogaNodeLike {
  getComputedTop(): number;
  getComputedHeight(): number;
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
  const planMode = useScheduleState(planModeAtom);
  const terminalSize = useTerminalSize();
  const inputBoxRef = useRef<DOMElement | null>(null);
  const setInputBoxRef = useCallback((el: DOMElement | null) => {
    inputBoxRef.current = el;
  }, []);

  useLayoutEffect(() => {
    const el = inputBoxRef.current;
    if (!el?.yogaNode || !terminalSize) return;

    const yoga = el.yogaNode as unknown as YogaNodeLike;
    let absoluteTop = yoga.getComputedTop();
    let parent: DOMElement | undefined = el.parentNode;
    while (parent) {
      if (parent.yogaNode) {
        absoluteTop += (parent.yogaNode as unknown as YogaNodeLike).getComputedTop();
      }
      parent = parent.parentNode;
    }

    const bottom = absoluteTop + yoga.getComputedHeight();
    const distance = Math.max(0, terminalSize.rows - bottom);
    inputBottomDistanceAtom.set(distance);
  });

  const preserveInputOnPluginHandle = activePluginUIs.some((ui) => ui.preserveInput);

  React.useEffect(() => {
    return terminalInput.text.listen((text) => {
      setInput(text);
      setCursorOffset(text.length);
    });
  }, []);

  const isAgentRunning = workingStatus.type !== 'idle' && workingStatus.type !== 'completed' && workingStatus.type !== 'error';

  useInput((_input, key, event) => {
    if (key.tab && key.shift) {
      const next = !planModeAtom.get();
      planModeAtom.set(next);
      const id = `plan-mode-${Date.now()}`;
      MessageBarAPI.addMessage({ id, text: next ? 'Plan mode 已激活 — 仅分析规划，不执行代码修改' : 'Plan mode 已关闭' });
      setTimeout(() => MessageBarAPI.removeMessage(id), 3000);
      return;
    }

    if (key.ctrl && (_input === '\x03' || _input === '')) {
      if (isAgentRunning) {
        agentTurn.abort();
        setInput('');
        setCursorOffset(0);
        return;
      }
    }

    // Bracket paste detection: Cmd+V / Ctrl+V with image on clipboard
    // sends empty bracketed paste sequence → isPasted=true, input=""
    if (event?.keypress?.isPasted) {
      console.log('[imagePaste] paste event:', { isPasted: true, inputLen: _input.length, hasKeypress: !!event?.keypress });
      if (_input.length === 0) {
        console.log('[imagePaste] empty paste detected, checking clipboard...');
        const imagePath = saveClipboardImage();
        console.log('[imagePaste] saveClipboardImage result:', imagePath);
        if (imagePath) {
          const ref = `[Image](${imagePath})`;
          const newText = input.slice(0, cursorOffset) + ref + input.slice(cursorOffset);
          setInput(newText);
          setCursorOffset(cursorOffset + ref.length);
          terminalInput.text.set(newText);
          return;
        }
      }
    }

    if ((key.ctrl || key.meta) && (_input === '\x16' || _input === 'v')) {
      appendSystemLog(`[imagePaste] Ctrl+V/Meta+V detected: ${JSON.stringify({ _input, ctrl: key.ctrl, meta: key.meta })}`);
      const imagePath = saveClipboardImage();
      appendSystemLog(`[imagePaste] saveClipboardImage result: ${imagePath}`);
      if (imagePath) {
        const ref = `[Image](${imagePath})`;
        const newText = input.slice(0, cursorOffset) + ref + input.slice(cursorOffset);
        setInput(newText);
        setCursorOffset(cursorOffset + ref.length);
        terminalInput.text.set(newText);
        return;
      }
    }

    let pluginHandled = false;
    for (const ui of activePluginUIs) {
      if (ui.onInput?.(_input, key)) {
        pluginHandled = true;
        if (!ui.preserveInput) {
          terminalInput.text.set('');
          setInput('');
          setCursorOffset(0);
        }
        return;
      }
    }

    // 交互式插件（非 preserveInput）未消费的按键 → 关闭插件
    if (!pluginHandled) {
      const interactivePlugins = activePluginUIs.filter((ui) => ui.onInput && !ui.preserveInput);
      if (interactivePlugins.length > 0) {
        // 仅修饰键不关闭
        if (!key.ctrl && !key.meta && _input) {
          pluginUIsAtom.set(activePluginUIs.filter((ui) => !ui.onInput || ui.preserveInput));
          if (_input === '/') {
            setInput('/');
            setCursorOffset(1);
            terminalInput.text.set('/');
          } else {
            setInput('');
            setCursorOffset(0);
            terminalInput.text.set('');
          }
          return;
        }
      }
    }

    if (key.escape) {
      const interactivePlugins = activePluginUIs.filter((ui) => ui.onInput);
      if (interactivePlugins.length === 0) {
        agentTurn.abort();
        setInput('');
        setCursorOffset(0);
        terminalInput.text.set('');
      }
      return;
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
    process.exit(0);
  }, [isAgentRunning]);

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
    <Box flexDirection="column" marginTop={1} ref={setInputBoxRef}>
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
          <Text bold color={planMode ? C.planMode : C.primary}>{'❯'}</Text>
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
    </Box>
  );
}

export const TerminalInputUI = {
  renderFn: TerminalInput,
  onSubmit: (cb: (text: string) => void) => emitter.on('submit', cb),
  offSubmit: (cb: (text: string) => void) => emitter.off('submit', cb),
  atomText: terminalInput.text,
  submit: (text: string) => emitter.emit('submit', text),
}