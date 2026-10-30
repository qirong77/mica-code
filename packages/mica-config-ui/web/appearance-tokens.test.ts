import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * 亮色皮肤的护栏。
 *
 * `styles.css` 的颜色全部走容器上的自定义属性，亮色块 `html[data-theme='light'] .mica-config-ui`
 * 必须逐个覆盖——漏一个（比如只改了 --line 忘了 --line-soft）在暗色下永远发现不了，切到亮色
 * 才会冒出一条深色分隔线。这里直接读源码断言覆盖完整，也挡住「再往规则里写死白 alpha」的回退。
 */
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** 从 `selector` 后面第一个 `{` 开始做括号配对，取出整块内容（选择器只取第一次出现）。 */
function blockAfter(selector: string): string {
  const at = styles.indexOf(selector);
  expect(at, `styles.css 里找不到选择器：${selector}`).toBeGreaterThanOrEqual(0);
  const open = styles.indexOf('{', at);
  let depth = 0;
  for (let index = open; index < styles.length; index += 1) {
    if (styles[index] === '{') depth += 1;
    else if (styles[index] === '}') {
      depth -= 1;
      if (depth === 0) return styles.slice(open + 1, index);
    }
  }
  throw new Error(`选择器块没有闭合：${selector}`);
}

/** 块里每一行 `--name: value;` 的声明（行内值后面的注释不参与比较）。 */
function declarations(block: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of block.split('\n')) {
    const match = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?);/i.exec(line);
    if (match) result.set(match[1]!, match[2]!.trim());
  }
  return result;
}

/** 值里出现颜色表达式的才是颜色 token；字号 / 字体 / 圆角这些不该被亮色块重复声明。 */
const COLOR_VALUE = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|color-mix\(/i;

const darkTokens = declarations(blockAfter('\n.mica-config-ui {'));
const lightTokens = declarations(blockAfter("html[data-theme='light'] .mica-config-ui {"));

describe('config-ui 亮色皮肤 token 覆盖', () => {
  it('暗色块里的每个颜色 token 在亮色块里都有覆盖', () => {
    const colorTokens = [...darkTokens].filter(([, value]) => COLOR_VALUE.test(value)).map(([name]) => name);
    // 暗色块确实有一整套颜色 token：解析写错（比如正则不匹配）时先在这里失败。
    expect(colorTokens.length).toBeGreaterThan(25);
    const missing = colorTokens.filter((name) => !lightTokens.has(name));
    expect(missing).toEqual([]);
  });

  it('亮色块覆盖任务要求的全部语义 token（含 --line-soft / 叠层 / 强调前景）', () => {
    const required = [
      '--bg',
      '--panel',
      '--panel-muted',
      '--panel-hover',
      '--sidebar-bg',
      '--line',
      '--line-soft',
      '--line-strong',
      '--text',
      '--text-soft',
      '--text-faint',
      '--accent',
      '--accent-hover',
      '--blue',
      '--green',
      '--red',
      '--amber',
      '--violet',
      '--overlay-subtle',
      '--overlay',
      '--overlay-strong',
      '--focus-ring',
      '--selection-bg',
      '--panel-inset',
      '--accent-contrast',
      '--shadow-modal',
    ];
    const missing = required.filter((name) => !lightTokens.has(name));
    expect(missing).toEqual([]);
  });

  it('亮色块只覆盖颜色，不重复声明尺寸 / 字体 token', () => {
    const layoutTokens = [...lightTokens.keys()].filter((name) => !COLOR_VALUE.test(lightTokens.get(name)!));
    expect(layoutTokens).toEqual([]);
  });

  it('规则里不再写死「暗色假设」的白色 alpha / Darcula 字面量', () => {
    // 允许出现的只有 token / 预览色板声明行，以及解释性注释。
    const offenders = styles.split('\n').filter((line) => {
      const hardcoded = /rgb\(\s*255\s+255\s+255|#1e1f22\b|#2b2b2b\b/i.test(line);
      const isDeclaration = /^\s*--[a-z0-9-]+\s*:/i.test(line);
      const isComment = /^\s*(\*|\/\*|<!--)/.test(line);
      return hardcoded && !isDeclaration && !isComment;
    });
    expect(offenders).toEqual([]);
  });

  it('主题卡预览色板与两个主题的 token 同值', () => {
    const previewLight = declarations(blockAfter(".theme-preview[data-preview-theme='light'] {"));
    const previewDark = declarations(blockAfter('  .theme-preview {'));

    expect(previewLight.get('--preview-bg')).toBe(lightTokens.get('--bg'));
    expect(previewLight.get('--preview-panel')).toBe(lightTokens.get('--panel-muted'));
    expect(previewLight.get('--preview-line')).toBe(lightTokens.get('--line'));
    expect(previewLight.get('--preview-text')).toBe(lightTokens.get('--text-soft'));
    expect(previewLight.get('--preview-accent')).toBe(lightTokens.get('--accent'));

    expect(previewDark.get('--preview-bg')).toBe(darkTokens.get('--bg'));
    expect(previewDark.get('--preview-panel')).toBe(darkTokens.get('--panel'));
    expect(previewDark.get('--preview-line')).toBe(darkTokens.get('--line'));
    expect(previewDark.get('--preview-text')).toBe(darkTokens.get('--text-soft'));
    expect(previewDark.get('--preview-accent')).toBe(darkTokens.get('--accent'));
  });
});
