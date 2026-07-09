import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import mitt from 'mitt';
import { state as dropdownState } from '../bottom/dropdown/state.js';
import { inputBottomDistance } from '../input/state.js';

export interface MessageItem {
  id: string;
  text: string;
}

type Events = { add: MessageItem; remove: string; clear: void; set: MessageItem[] };
const emitter = mitt<Events>();
type PendingEvent =
  | { type: 'add'; item: MessageItem }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'set'; items: MessageItem[] };

let isMounted = false;
let pendingEvents: PendingEvent[] = [];

const MIN_VISIBLE = 3;

let currentItems: MessageItem[] = [];

export const MessageBarAPI = {
  addMessage: (item: MessageItem) => {
    if (!isMounted) {
      pendingEvents.push({ type: 'add', item });
      return;
    }
    emitter.emit('add', item);
  },
  removeMessage: (id: string) => {
    if (!isMounted) {
      pendingEvents.push({ type: 'remove', id });
      return;
    }
    emitter.emit('remove', id);
  },
  clearMessages: () => {
    if (!isMounted) {
      pendingEvents.push({ type: 'clear' });
      return;
    }
    emitter.emit('clear');
  },
  setMessages: (items: MessageItem[]) => {
    const nextItems = [...items];
    currentItems = nextItems;
    if (!isMounted) {
      pendingEvents.push({ type: 'set', items: nextItems });
      return;
    }
    emitter.emit('set', nextItems);
  },
  getMessages: () => [...currentItems],
};

export const MessageBar = React.memo(function MessageBar() {
  const [items, setItems] = useState<MessageItem[]>([]);
  const bottomDistance =
    React.useSyncExternalStore?.(inputBottomDistance.subscribe, inputBottomDistance.get as () => number) ??
    inputBottomDistance.get();

  const maxVisible = useMemo(() => Math.max(MIN_VISIBLE, bottomDistance - 4), [bottomDistance]);
  const maxBufferRef = useRef(maxVisible * 2);
  maxBufferRef.current = maxVisible * 2;

  useEffect(() => {
    const onAdd = (item: MessageItem) =>
      setItems((prev) => {
        const next = [...prev, item];
        currentItems = next.length > maxBufferRef.current ? next.slice(-maxBufferRef.current) : next;
        return currentItems;
      });
    const onRemove = (id: string) =>
      setItems((prev) => {
        currentItems = prev.filter((s) => s.id !== id);
        return currentItems;
      });
    const onClear = () => {
      currentItems = [];
      setItems([]);
    };
    const onSet = (nextItems: MessageItem[]) => {
      currentItems = [...nextItems];
      setItems(currentItems);
    };
    emitter.on('add', onAdd);
    emitter.on('remove', onRemove);
    emitter.on('clear', onClear);
    emitter.on('set', onSet);
    isMounted = true;
    for (const event of pendingEvents) {
      if (event.type === 'add') onAdd(event.item);
      if (event.type === 'remove') onRemove(event.id);
      if (event.type === 'clear') onClear();
      if (event.type === 'set') onSet(event.items);
    }
    pendingEvents = [];
    let prevVisible = false;
    const unsub = dropdownState.subscribe((state) => {
      if (state.visible && !prevVisible) onClear();
      prevVisible = state.visible;
    });
    return () => {
      emitter.off('add', onAdd);
      emitter.off('remove', onRemove);
      emitter.off('clear', onClear);
      emitter.off('set', onSet);
      unsub();
      isMounted = false;
    };
  }, []);

  const visible = useMemo(() => items.slice(-maxVisible), [items, maxVisible]);
  if (visible.length === 0) return null;

  return (
    <Box flexDirection="column">
      {visible.map((s) => (
        <Box key={s.id}>
          <Text dimColor>{s.text}</Text>
        </Box>
      ))}
    </Box>
  );
});
