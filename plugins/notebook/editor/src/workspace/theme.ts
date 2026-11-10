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
