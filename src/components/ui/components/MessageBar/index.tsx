import React, { useEffect, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import mitt from 'mitt';
import { dropdown } from '../../../../store/ui-state.js';

// ── 事件定义 ──────────────────────────────────────────

type Events = {
  add: { id: string; text: string };
  remove: string;
  clear: void;
};

const emitter = mitt<Events>();

// ── 渲染组件 ──────────────────────────────────────────

const MAX_VISIBLE = 10;

interface MessageItem {
  id: string;
  text: string;
}

export const MessageBarAPI = {
  addMessage: (item: { id: string; text: string }) => emitter.emit('add', item),
  removeMessage: (id: string) => emitter.emit('remove', id),
  clearMessages: () => emitter.emit('clear'),
};

export const MessageBar = React.memo(function MessageBar(): React.ReactNode {
  const [items, setItems] = useState<MessageItem[]>([]);

  useEffect(() => {
    const onAdd = (item: { id: string; text: string }) => {
      setItems(prev => {
        const next = [...prev, item];
        if (next.length > MAX_VISIBLE * 2) {
          return next.slice(-MAX_VISIBLE * 2);
        }
        return next;
      });
    };
    const onRemove = (id: string) => {
      setItems(prev => prev.filter(s => s.id !== id));
    };
    const onClear = () => {
      setItems([]);
    };

    emitter.on('add', onAdd);
    emitter.on('remove', onRemove);
    emitter.on('clear', onClear);

    const unsubDropdown = dropdown.atom.subscribe((state) => {
      if (state.visible) setItems([]);
    });

    return () => {
      emitter.off('add', onAdd);
      emitter.off('remove', onRemove);
      emitter.off('clear', onClear);
      unsubDropdown();
    };
  }, []);

  const visible = items.slice(-MAX_VISIBLE);
  if (visible.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1} borderBottom={true} borderStyle="dashed" borderColor='ansi:cyan'>
      {visible.map((s) => (
        <Box key={s.id}>
          <Text dimColor>{s.text}</Text>
        </Box>
      ))}
    </Box>
  );
});
