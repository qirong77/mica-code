import React, { useEffect, useState } from 'react';
import { Text } from '@anthropic/ink';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function useSpinner(delay = 80): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), delay);
    return () => clearInterval(timer);
  }, [delay]);
  return SPINNER_FRAMES[frame];
}

export function Spin({ delay }: { delay?: number }) {
  const spinner = useSpinner(delay);
  return <Text>{spinner} </Text>;
}
