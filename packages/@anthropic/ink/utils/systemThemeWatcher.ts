import { oscColor, type TerminalQuerier } from '../src/core/terminal-querier.js';
import { systemThemeFromOscColor, type SystemTheme } from '../src/theme/systemTheme.js';

/**
 * Watch for live terminal theme changes via OSC 11 polling.
 * Stub implementation for the standalone @anthropic/ink package.
 */
export function watchSystemTheme(
  querier: TerminalQuerier,
  setTheme: (theme: SystemTheme) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async () => {
    if (stopped) return;
    const responsePromise = querier.send(oscColor(11));
    await querier.flush();
    const response = await responsePromise;
    const theme = response ? systemThemeFromOscColor(response.data) : undefined;
    if (!stopped && theme) setTheme(theme);
    if (!stopped) timer = setTimeout(() => void poll(), 30_000);
  };

  void poll();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
