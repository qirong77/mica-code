import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from '@anthropic/ink';
import mitt from 'mitt';
import { state as dropdownState } from '../bottom/dropdown/data.js';
import { inputBottomDistance } from '../input/data.js';

type Events = { add: { id: string; text: string }; remove: string; clear: void };
const emitter = mitt<Events>();
type PendingEvent = { type: 'add'; item: MessageItem } | { type: 'remove'; id: string } | { type: 'clear' };

let isMounted = false;
let pendingEvents: PendingEvent[] = [];

const MIN_VISIBLE = 3;

interface MessageItem { id: string; text: string }

export const MessageBarAPI = {
  addMessage: (item: MessageItem) => { if (!isMounted) { pendingEvents.push({ type: 'add', item }); return; } emitter.emit('add', item); },
  removeMessage: (id: string) => { if (!isMounted) { pendingEvents.push({ type: 'remove', id }); return; } emitter.emit('remove', id); },
  clearMessages: () => { if (!isMounted) { pendingEvents.push({ type: 'clear' }); return; } emitter.emit('clear'); },
};

export const MessageBar = React.memo(function MessageBar() {
  const [items, setItems] = useState<MessageItem[]>([]);
  const bottomDistance = React.useSyncExternalStore?.(inputBottomDistance.subscribe, inputBottomDistance.get as () => number) ?? inputBottomDistance.get();

  const maxVisible = useMemo(() => Math.max(MIN_VISIBLE, bottomDistance - 4), [bottomDistance]);
  const maxBufferRef = useRef(maxVisible * 2);
  maxBufferRef.current = maxVisible * 2;

  useEffect(() => {
    const onAdd = (item: MessageItem) => setItems(prev => { const next = [...prev, item]; return next.length > maxBufferRef.current ? next.slice(-maxBufferRef.current) : next; });
    const onRemove = (id: string) => setItems(prev => prev.filter(s => s.id !== id));
    const onClear = () => setItems([]);
    emitter.on('add', onAdd); emitter.on('remove', onRemove); emitter.on('clear', onClear);
    isMounted = true;
    for (const event of pendingEvents) {
      if (event.type === 'add') onAdd(event.item);
      if (event.type === 'remove') onRemove(event.id);
      if (event.type === 'clear') onClear();
    }
    pendingEvents = [];
    let prevVisible = false;
    const unsub = dropdownState.subscribe(state => { if (state.visible && !prevVisible) setItems([]); prevVisible = state.visible; });
    return () => { emitter.off('add', onAdd); emitter.off('remove', onRemove); emitter.off('clear', onClear); unsub(); isMounted = false; };
  }, []);

  const visible = useMemo(() => items.slice(-maxVisible), [items, maxVisible]);
  if (visible.length === 0) return null;

  return (
    <Box flexDirection="column">
      {visible.map(s => <Box key={s.id}><Text dimColor>{s.text}</Text></Box>)}
    </Box>
  );
});
