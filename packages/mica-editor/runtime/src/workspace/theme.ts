/** Host colors are already resolved in the parent (including relative colors).
 * Keep the semantic tokens intact; virtual:mica-arco-theme.css owns Arco's
 * channel lists and component overrides, just as it does in the desktop app.
 */
export function applyNotebookTheme(appearance: unknown, tokens: unknown): void {
  const root = document.documentElement;
  const dark = appearance === 'dark';
  document.body.classList.add('mica-arco-theme');
  document.body.setAttribute('arco-theme', dark ? 'dark' : 'light');
  root.dataset.appearance = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return;

  const entries = Object.entries(tokens).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && Boolean(entry[1].trim()),
  );
  const setToken = (name: string, value: string) => {
    root.style.setProperty(name, value.trim());
    document.body.style.setProperty(name, value.trim());
  };

  for (const [key, value] of entries) {
    if (/^--[a-zA-Z0-9_-]+$/.test(key)) setToken(key, value);
    if (['font-family', 'fontFamily', '--font-family', '--chat-font-family'].includes(key) && CSS.supports('font-family', value)) {
      setToken('--notebook-font-family', value);
    }
  }
}

/** The host draws the notebook's document bar in this toolbar's row, left and
 * right of it. It reports how wide each segment is so the toolbar can reserve
 * exactly that much instead of guessing a fixed padding.
 */
export function applyNotebookBarInsets(input: unknown): void {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const root = document.documentElement;
  const clamp = (value: unknown, max: number) => {
    const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
    return Math.min(Math.max(number, 0), max);
  };
  root.style.setProperty('--notebook-bar-inset-left', `${clamp(source.left, 720)}px`);
  root.style.setProperty('--notebook-bar-inset-right', `${clamp(source.right, 720)}px`);
  const height = clamp(source.height, 96);
  if (height >= 36) root.style.setProperty('--notebook-bar-height', `${height}px`);
  else root.style.removeProperty('--notebook-bar-height');
}
