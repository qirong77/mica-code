import { useEffect, useState } from 'react';
import ButtonModule from '@arco-design/web-react/lib/Button/index.js';
import '@arco-design/web-react/es/Button/style/index.css';
import SiteIcon from './SiteIcon';

type Theme = 'light' | 'dark';

// Arco's CommonJS entry supports Node SSR as well as Vite's browser interop.
const Button = (ButtonModule as unknown as { default?: typeof ButtonModule }).default ?? ButtonModule;

export default function ThemeToggle() {
  // Keep server markup independent of the stored theme restored by the head script.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const syncTheme = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    syncTheme();
    window.addEventListener('mica:theme-change', syncTheme);
    return () => window.removeEventListener('mica:theme-change', syncTheme);
  }, []);

  const label = theme === null ? '切换网站主题' : theme === 'dark' ? '切换到浅色主题' : '切换到深色主题';

  const toggleTheme = () => {
    const root = document.documentElement;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    if (next === 'dark') document.body.setAttribute('arco-theme', 'dark');
    else document.body.removeAttribute('arco-theme');
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', next === 'dark' ? '#0b1017' : '#f8fafc');
    try {
      localStorage.setItem('mica-site-theme', next);
    } catch {}
    setTheme(next);
    window.dispatchEvent(new CustomEvent('mica:theme-change', { detail: next }));
  };

  return (
    <Button className="theme-toggle icon-button" aria-label={label} title={label} onClick={toggleTheme}>
      <SiteIcon name="sun" size={18} className="theme-sun" />
      <SiteIcon name="moon" size={18} className="theme-moon" />
    </Button>
  );
}
