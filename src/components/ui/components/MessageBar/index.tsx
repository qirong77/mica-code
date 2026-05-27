import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import mitt from 'mitt';
import { dropdown } from '../../../../store/ui-state.js';

type Events = {
  add: { id: string; text: string };
  remove: string;
  clear: void;
};

const emitter = mitt<Events>();

const MAX_VISIBLE = 10;
const MAX_BUFFER = MAX_VISIBLE * 2;

interface MessageItem {
  id: string;
  text: string;
}

export const MessageBarAPI = {
  addMessage: (item: MessageItem) => emitter.emit('add', item),
  removeMessage: (id: string) => emitter.emit('remove', id),
  clearMessages: () => emitter.emit('clear'),
};

export const MessageBar = React.memo(function MessageBar() {
  const [items, setItems] = useState<MessageItem[]>([]);

  useEffect(() => {
    const onAdd = (item: MessageItem) => {
      setItems(prev => {
        const next = [...prev, item];
        return next.length > MAX_BUFFER ? next.slice(-MAX_BUFFER) : next;
      });
    };
    const onRemove = (id: string) => setItems(prev => prev.filter(s => s.id !== id));
    const onClear = () => setItems([]);

    emitter.on('add', onAdd);
    emitter.on('remove', onRemove);
    emitter.on('clear', onClear);

    const unsubDropdown = dropdown.state.subscribe(state => {
      if (state.visible) setItems([]);
    });

    return () => {
      emitter.off('add', onAdd);
      emitter.off('remove', onRemove);
      emitter.off('clear', onClear);
      unsubDropdown();
    };
  }, []);

  const visible = useMemo(() => items.slice(-MAX_VISIBLE), [items]);
  if (visible.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1} borderBottom borderStyle="dashed" borderColor="ansi:cyan">
      {visible.map(s => (
        <Box key={s.id}>
          <Text dimColor>{s.text}</Text>
        </Box>
      ))}
    </Box>
  );
});
