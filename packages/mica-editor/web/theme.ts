// The standalone settings host defines semantic colors on .mica-config-ui rather than :root.
// Map those names only; the six palettes continue to live in the host stylesheets.
const CONFIG_TOKENS: Record<string, string> = {
  '--color-canvas': '--bg',
  '--color-panel': '--panel',
  '--color-panel-hi': '--panel-muted',
  '--color-line': '--line',
  '--color-line-soft': '--line-soft',
  '--color-line-strong': '--line-strong',
  '--color-fg-strong': '--text',
  '--color-fg-max': '--text',
  '--color-fg-soft': '--text-soft',
  '--color-fg-faint': '--text-faint',
  '--color-fg-dim': '--text-faint',
  '--color-overlay-subtle': '--overlay-subtle',
  '--color-overlay': '--overlay',
  '--color-overlay-strong': '--overlay-strong',
  '--color-shade': '--overlay-strong',
  '--color-accent-hover': '--accent-hover',
  '--color-info': '--blue',
  '--color-purple': '--violet',
  '--color-surface': '--panel-muted',
  '--color-hover': '--panel-hover',
  '--color-active': '--panel-hover',
  '--color-border': '--line',
  '--color-fg': '--text',
  '--color-fg-secondary': '--text-soft',
  '--color-fg-muted': '--text-faint',
  '--color-accent': '--accent',
  '--color-accent-contrast': '--accent-contrast',
  '--color-link': '--blue',
  '--color-success': '--green',
  '--color-warn': '--amber',
  '--color-danger': '--red',
};

/** Resolve var()/relative colors in the host, just as the notebook host does. */
export function readEditorTheme(container: HTMLElement) {
  const root = document.documentElement;
  const style = getComputedStyle(container);
  const swatch = document.createElement('span');
  swatch.hidden = true;
  container.appendChild(swatch);
  const tokens: Record<string, string> = {};
  try {
    for (let index = 0; index < style.length; index += 1) {
      const key = style.item(index);
      if (!key.startsWith('--color-')) continue;
      swatch.style.color = `var(${key})`;
      tokens[key] = getComputedStyle(swatch).color;
    }
    for (const [key, source] of Object.entries(CONFIG_TOKENS)) {
      if (tokens[key] || !style.getPropertyValue(source).trim()) continue;
      swatch.style.color = `var(${source})`;
      tokens[key] = getComputedStyle(swatch).color;
    }
    tokens['--chat-text-size'] = style.getPropertyValue('--chat-text-size').trim() || style.fontSize;
    tokens['font-family'] = style.fontFamily;
    tokens['--font-mono'] = style.getPropertyValue('--font-mono').trim();
  } finally {
    swatch.remove();
  }
  return { appearance: root.dataset.appearance || (style.colorScheme === 'dark' ? 'dark' : 'light'), tokens };
}
