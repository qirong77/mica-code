import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 界面上只允许一份控件（`@mica-config-ui/web`）。
 *
 * 原生 `<select>` / `type="date"` / `type="checkbox"` 的弹层与外观由系统绘制：位置不受
 * 页面控制，在浮层与内嵌视图里会飘出控件；选项一多（几百个分支）就铺满整屏、点不动
 * 也关不掉，旁边的共享控件也对不齐。真机验收过一轮，这里按源码静态挡住，避免下次又
 * 从某个页面或插件里长回来。
 *
 * 允许的原生控件只有共享控件自己的实现（外观仍走它们）——见 ALLOWED。
 */
const NATIVE = [
  { pattern: /<select\b/, hint: '用 SelectMenu（可 filterable / 分组）' },
  { pattern: /type="date"/, hint: '用 DateField' },
  { pattern: /type="checkbox"/, hint: '用 Checkbox / Switch' },
  { pattern: /type="radio"/, hint: '用 Segmented / SelectMenu' },
];

/** 共享控件自己的实现：原生 input 在这里是正确的，外观与键盘行为由它们统一提供。 */
const ALLOWED = new Set(['components/Ui.tsx', 'components/DateField.tsx', 'components/SecretInput.tsx']);

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SCANNED = [
  join(ROOT, 'packages/mica-config-ui/web'),
  join(ROOT, 'apps/desktop/src/renderer/src'),
  join(ROOT, 'apps/config-web'),
  join(ROOT, 'plugins'),
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'node_modules' || name === 'dist' || name === 'out') return [];
    if (statSync(full).isDirectory()) return sources(full);
    if (!/\.(jsx|tsx)$/.test(name)) return [];
    if (/\.(test|spec)\.(jsx|tsx)$/.test(name)) return [];
    return [full];
  });
}

/** 只看真正的代码行：注释里提到「不要用原生控件」本身不该算违规。 */
function codeText(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !(
        trimmed.startsWith('//') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('{/*')
      );
    })
    .join('\n');
}

describe('界面控件统一', () => {
  it('生产代码里不出现原生下拉 / 日期 / 勾选框', () => {
    const offenders = SCANNED.flatMap((dir) =>
      sources(dir).flatMap((file) => {
        const relative = file.slice(ROOT.length + 1);
        if (relative.startsWith('packages/mica-config-ui/web/')) {
          const inner = relative.slice('packages/mica-config-ui/web/'.length);
          if (ALLOWED.has(inner)) return [];
        }
        const text = codeText(readFileSync(file, 'utf8'));
        return NATIVE.filter(({ pattern }) => pattern.test(text)).map(({ hint }) => `${relative} → ${hint}`);
      }),
    );
    expect(offenders).toEqual([]);
  });
});
