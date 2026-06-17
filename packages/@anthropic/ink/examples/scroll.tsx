#!/usr/bin/env bun

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, ScrollBox, useInput, wrappedRender, AlternateScreen } from '../src';
import type { ScrollBoxHandle } from '../src';

type PanelId = 'log' | 'errors' | 'debug';

function LogPanel({
  id,
  title,
  messages,
  isFocused,
  onFocus,
}: {
  id: PanelId;
  title: string;
  messages: string[];
  isFocused: boolean;
  onFocus: (id: PanelId) => void;
}) {
  const scrollRef = useRef<ScrollBoxHandle>(null);

  useInput(
    (_input, key) => {
      if (key.wheelUp) scrollRef.current?.scrollBy(-3);
      if (key.wheelDown) scrollRef.current?.scrollBy(3);
    },
    { isActive: isFocused },
  );

  useEffect(() => {
    if (!isFocused) return;
    const s = scrollRef.current;
    if (!s) return;
    const timer = setInterval(() => {
      if (s.isSticky()) s.scrollToBottom();
    }, 500);
    return () => clearInterval(timer);
  }, [isFocused]);

  return (
    <Box flexDirection="column" flexGrow={1} width="33%">
      <Box paddingX={1} flexShrink={0}>
        <Text bold={isFocused} color={isFocused ? 'permission' : undefined}>
          {title} {isFocused ? '◀' : ''}
        </Text>
      </Box>
      <ScrollBox
        ref={scrollRef}
        stickyScroll
        flexDirection="column"
        flexGrow={1}
        borderStyle={isFocused ? 'single' : undefined}
        borderColor={isFocused ? 'ansi:green' : undefined}
        tabIndex={0}
        autoFocus={isFocused}
        onClick={() => onFocus(id)}
        onMouseEnter={() => onFocus(id)}
      >
        <Box paddingX={1} flexDirection="column">
          {messages.length === 0 ? (
            <Text dimColor>(empty)</Text>
          ) : (
            messages.map((msg, i) => {
              const isError = msg.includes('ERROR');
              const isWarn = msg.includes('WARN');
              return (
                <Text
                  key={`${id}-${i}`}
                  color={isError ? '#D75F5F' : isWarn ? '#D7AF5F' : undefined}
                  dimColor={!isError && !isWarn}
                >
                  {msg}
                </Text>
              );
            })
          )}
        </Box>
      </ScrollBox>
    </Box>
  );
}

function App() {
  const [messages, setMessages] = useState<string[]>([]);
  const [counter, setCounter] = useState(0);
  const [paused, setPaused] = useState(false);
  const [focusedPanel, setFocusedPanel] = useState<PanelId>('log');

  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => {
      setCounter((n) => {
        const next = n + 1;
        const now = new Date().toISOString().slice(11, 23);
        const types = ['INFO ', 'WARN ', 'DEBUG', 'ERROR'];
        const type = types[(next % 47) % 4]!;
        setMessages((prev) => [...prev.slice(-500), `[${now}] ${type}  Log entry #${next}`]);
        return next;
      });
    }, 200);
    return () => clearInterval(id);
  }, [paused]);

  const logMessages = messages.filter((m) => m.includes('INFO ') || m.includes('WARN '));
  const errorMessages = messages.filter((m) => m.includes('ERROR'));
  const debugMessages = messages.filter((m) => m.includes('DEBUG'));

  useInput((input, key, event) => {
    if (key.escape) process.exit(0);
    if (input === ' ') {
      setPaused((p) => !p);
      return;
    }
    if (key.tab) {
      event.stopImmediatePropagation();
      const order: PanelId[] = ['log', 'errors', 'debug'];
      const idx = order.indexOf(focusedPanel);
      setFocusedPanel(order[(idx + 1) % 3]!);
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      <Box paddingX={1} paddingY={0} flexShrink={0}>
        <Text bold>ScrollBox + Click-to-Focus Demo</Text>
        <Text dimColor> — click or hover a panel to focus · mouse wheel to scroll</Text>
      </Box>
      <Box paddingX={1} paddingY={0} flexShrink={0}>
        <Text dimColor>Tab=switch panel · Space=pause {paused ? '[PAUSED]' : '[LIVE]'} · Esc=exit</Text>
      </Box>

      <Box flexDirection="row" flexGrow={1} gap={1} paddingX={1}>
        <LogPanel
          id="log"
          title="All Logs"
          messages={logMessages}
          isFocused={focusedPanel === 'log'}
          onFocus={setFocusedPanel}
        />
        <LogPanel
          id="errors"
          title="Errors"
          messages={errorMessages}
          isFocused={focusedPanel === 'errors'}
          onFocus={setFocusedPanel}
        />
        <LogPanel
          id="debug"
          title="Debug"
          messages={debugMessages}
          isFocused={focusedPanel === 'debug'}
          onFocus={setFocusedPanel}
        />
      </Box>

      <Box paddingX={1} paddingY={0} flexShrink={0}>
        <Text dimColor>
          Focused: {focusedPanel} · {messages.length} total messages
        </Text>
      </Box>
    </Box>
  );
}

function Root() {
  return (
    <AlternateScreen mouseTracking={true}>
      <App />
    </AlternateScreen>
  );
}

const instance = await wrappedRender(<Root />);
await instance.waitUntilExit();
