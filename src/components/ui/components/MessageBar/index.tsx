import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import mitt from 'mitt';
import { dropdown, inputBottomDistanceAtom } from '../../../../store/ui-state.js';
import { useScheduleState } from '../../hooks/index.js';
import { C } from '../../data.js';

type Events = {
  add: { id: string; text: string };
  remove: string;
  clear: void;
};

const emitter = mitt<Events>();

const MIN_VISIBLE = 3;

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
  const bottomDistance = useScheduleState(inputBottomDistanceAtom);

  const maxVisible = useMemo(() => {
    const reserved = 4;
    return Math.max(MIN_VISIBLE, bottomDistance - reserved);
  }, [bottomDistance]);

  const maxBuffer = maxVisible * 2;
  const maxBufferRef = useRef(maxBuffer);
  maxBufferRef.current = maxBuffer;

  useEffect(() => {
    const onAdd = (item: MessageItem) => {
      setItems(prev => {
        const next = [...prev, item];
        return next.length > maxBufferRef.current ? next.slice(-maxBufferRef.current) : next;
      });
    };
    const onRemove = (id: string) => setItems(prev => prev.filter(s => s.id !== id));
    const onClear = () => setItems([]);

    emitter.on('add', onAdd);
    emitter.on('remove', onRemove);
    emitter.on('clear', onClear);

    let prevVisible = false;
    const unsubDropdown = dropdown.state.subscribe(state => {
      if (state.visible && !prevVisible) setItems([]);
      prevVisible = state.visible;
    });

    return () => {
      emitter.off('add', onAdd);
      emitter.off('remove', onRemove);
      emitter.off('clear', onClear);
      unsubDropdown();
    };
  }, []);

  const visible = useMemo(() => items.slice(-maxVisible), [items, maxVisible]);
  if (visible.length === 0) return null;

  return (
    <Box flexDirection="column" paddingX={1} borderBottom borderStyle="dashed" borderColor={C.border}>
      {visible.map(s => (
        <Box key={s.id}>
          <Text dimColor>{s.text}</Text>
        </Box>
      ))}
    </Box>
  );
});
