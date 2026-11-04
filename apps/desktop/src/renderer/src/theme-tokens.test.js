import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_DARK_THEME, THEMES } from '@packages/mica-web-shared/index.js'

/**
 * 颜色主题契约测试：`assets/app.css` 是渲染层唯一的颜色来源。
 *
 * 主题切换只改 `<html data-theme>`（具体主题）与 `<html data-appearance>`（亮/暗档），
 * 所以三条硬约束：
 * - 注册表（`packages/mica-web-shared/theme.ts` 的 THEMES）里的每个主题都要在 app.css 里
 *   有 `html[data-theme='<id>']` 块，且覆盖 `@theme` 的每一个 `--color-*`——漏一个就在
 *   该主题下漏成 Darcula 的值；
 * - 每个主题块里的前景/状态色要在自己的画布上可读（亮色档的 soft 必须比 primary 更深）；
 * - 规则里不许再出现 `rgb(255 255 255 / N%)` 这种写死的白色 alpha——它必须写成
 *   `color-mix(in srgb, var(--color-fg-max) N%, transparent)`，亮色里才会自动变黑。
 *
 * 「亮底要单独处理」的那些规则（阴影权重、查找条输入框、行内代码药丸、屏幕涂层）挂在
 * `html[data-appearance='light']` 上，新增主题自动继承，不必再配一遍。
 *
 * 例外只有两类，都在下面显式放行：主题块自己的 token 定义（它们就是字面量），
 * 以及 `::highlight(chat-find-*)` 的命中高亮（琥珀色固定，不随主题变）。注释里的颜色说明
 * 不算残留。
 */
const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/app.css')
const css = readFileSync(CSS_PATH, 'utf8')

const RENDERER_DIR = resolve(dirname(fileURLToPath(import.meta.url)))
const PLUGINS_DIR = resolve(RENDERER_DIR, '../../../../../plugins')
const CONFIG_UI_CSS = readFileSync(
  resolve(RENDERER_DIR, '../../../../../packages/mica-config-ui/web/styles.css'),
  'utf8'
)

/** 去掉块注释：注释里可以提颜色字面量（设计说明），不是残留。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 从 `{` 之前的任意位置出发，返回配对花括号块的 [openBrace, afterCloseBrace) 下标。 */
function braceRange(source, from) {
  const open = source.indexOf('{', from)
  if (open < 0) return null
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return [open, i + 1]
    }
  }
  return null
}

/** 用一条选择器正则找到块内容；找不到返回 null。 */
function blockFor(source, pattern) {
  const match = pattern.exec(source)
  if (!match) return null
  const range = braceRange(source, match.index)
  if (!range) return null
  return source.slice(range[0] + 1, range[1] - 1)
}

/** 反复删除匹配到的整块（例如两个 ::highlight 规则、两个主题块）。 */
function removeAllBlocks(source, pattern) {
  let result = source
  for (;;) {
    const range = (() => {
      const match = pattern.exec(result)
      return match ? braceRange(result, match.index) : null
    })()
    if (!range) return result
    result = result.slice(0, range[0] - 1) + result.slice(range[1])
  }
}

/** 取出规则体里 box-shadow 的黑色 alpha（%）。 */
function shadowAlpha(body) {
  const match = /box-shadow:[^;]*rgb\(0 0 0 \/ (\d+)%\)/.exec(body ?? '')
  return match ? Number(match[1]) : null
}

/** 定位一条顶层规则（`light` = 限定在「亮底」那一档的覆盖规则下）。 */
function ruleBody(selector, { light = false } = {}) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const prefix = light ? "html\\[data-appearance='light'\\] " : ''
  return blockFor(stripComments(css), new RegExp(`^${prefix}${escaped} \\{`, 'm'))
}

const cleanCss = stripComments(css)
const themeBlock = blockFor(cleanCss, /^@theme\s*\{/m)
const lightBlock = blockFor(cleanCss, /^html\[data-theme='light'\]\s*\{/m)

/**
 * 注册表里每个主题在 app.css 里的 token 块；缺块时为 null（下面的用例会因此失败）。
 * 默认暗色（darcula）的取值写在 `@theme` 里，没有自己的 `html[data-theme]` 块。
 */
const themeBlocks = new Map(
  THEMES.map((theme) => [
    theme.id,
    theme.id === DEFAULT_DARK_THEME
      ? themeBlock
      : blockFor(cleanCss, new RegExp(`^html\\[data-theme='${theme.id}'\\]\\s*\\{`, 'm'))
  ])
)

/** `terminal-theme.js` 里每个主题对应的常量名（表是按主题手写的，名字不会自动对齐）。 */
const TERMINAL_CONSTANTS = {
  dark: 'DARK',
  light: 'LIGHT',
  mocha: 'MOCHA',
  latte: 'LATTE',
  'tokyo-night': 'TOKYO_NIGHT',
  'tokyo-night-light': 'TOKYO_NIGHT_LIGHT'
}

/** 语义色 token 名（出现顺序去重）。 */
function colorTokens(block) {
  return [...new Set([...block.matchAll(/--color-[\w-]+(?=\s*:)/g)].map((match) => match[0]))]
}

/** 主题块里某个 token 的 hex 值；不是 hex（如 color-mix）时返回 null。 */
function hexToken(name, block = lightBlock) {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block ?? '')
  return match ? match[1].toLowerCase() : null
}

/** 兼容旧名字：默认读「浅色」主题那一块。 */
const lightHexToken = (name) => hexToken(name, lightBlock)

/** WCAG 相对亮度：只用来验证「白/近白底上的文字色」够不够黑。 */
function srgbChannel(value) {
  const channel = value / 255
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

/** 两色对比度（WCAG）。默认白底；深色主题传画布色。 */
function contrastRatio(hex, background = '#ffffff') {
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16))
  const luminance = 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b)
  const [br, bg2, bb] = [1, 3, 5].map((start) => parseInt(background.slice(start, start + 2), 16))
  const back =
    0.2126 * srgbChannel(br) + 0.7152 * srgbChannel(bg2) + 0.0722 * srgbChannel(bb)
  const [high, low] = [luminance, back].sort((a, b) => b - a)
  return (high + 0.05) / (low + 0.05)
}

describe('app.css 颜色 token 主题契约', () => {
  it('注册表里的每个主题都有 token 块，且覆盖 @theme 的全部 --color-*', () => {
    expect(themeBlock).not.toBeNull()
    expect(lightBlock).not.toBeNull()
    expect(THEMES.length).toBeGreaterThanOrEqual(2)

    const baseTokens = colorTokens(themeBlock)
    expect(baseTokens.length).toBeGreaterThan(30)
    for (const theme of THEMES) {
      const block = themeBlocks.get(theme.id)
      expect(block, `${theme.id} 在 app.css 里缺少 html[data-theme='${theme.id}'] 块`).not.toBeNull()
      const tokens = new Set(colorTokens(block))
      expect(
        baseTokens.filter((token) => !tokens.has(token)),
        `${theme.id} 漏了这些 token`
      ).toEqual([])
      // 画布色必须与注册表里登记的 canvas 一致：首帧底色、<meta theme-color> 都用它。
      expect(new RegExp(`--color-canvas:\\s*${theme.canvas};`).test(block), theme.id).toBe(true)
    }
  })

  it('洗色层与 line-soft 两套主题都定义（暗色白 alpha，亮色黑 alpha）', () => {
    const tokens = [
      '--color-overlay-subtle',
      '--color-overlay',
      '--color-overlay-strong',
      '--color-overlay-heavy',
      '--color-shade',
      '--color-line-soft'
    ]
    for (const token of tokens) {
      expect(themeBlock).toContain(`${token}:`)
      expect(lightBlock).toContain(`${token}:`)
    }
  })

  it('暗色 token 的取值没有被主题化改写', () => {
    expect(themeBlock).toContain('--color-overlay-subtle: rgb(255 255 255 / 3%)')
    expect(themeBlock).toContain('--color-overlay: rgb(255 255 255 / 6%)')
    expect(themeBlock).toContain('--color-overlay-strong: rgb(255 255 255 / 10%)')
    expect(themeBlock).toContain('--color-overlay-heavy: rgb(255 255 255 / 15%)')
    expect(themeBlock).toContain('--color-shade: rgb(0 0 0 / 10%)')
    expect(themeBlock).toContain('--color-line-soft: rgb(255 255 255 / 7%)')
    expect(themeBlock).toContain('--color-fg-max: #ffffff')
  })

  /**
   * 组件里写 `bg-white/10`、`text-white/40` 这类 Tailwind 白色 alpha，暗色下是提亮、
   * 亮色下白字白底直接消失——它们必须写成 `--color-overlay-*` / `--color-fg-*` token。
   * 不带 alpha 的纯白（实心彩底上的白字、开关的白色圆钮）两种主题下都对，放行；
   * 固定黑遮罩（`bg-black/55` 盖在整页上）是有意为之，也不在检查范围。
   */
  it('渲染层与插件里没有白色 alpha / 纯白前景的工具类', () => {
    const offenders = []
    const pattern =
      /\b(?:text|bg|border|divide|from|via|to|ring|placeholder|decoration|outline)-white\/[\d[]/
    for (const root of [RENDERER_DIR, PLUGINS_DIR]) {
      for (const file of readdirSync(root, { recursive: true })) {
        const name = String(file)
        if (!name.endsWith('.jsx') && !name.endsWith('.js')) continue
        if (name.endsWith('.test.js') || name.includes('node_modules')) continue
        const source = readFileSync(resolve(root, name), 'utf8')
        source.split('\n').forEach((line, index) => {
          if (pattern.test(line)) offenders.push(`${name}:${index + 1}: ${line.trim()}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })

  it('规则里没有残留白色 alpha 字面量（注释 / token 定义 / chat-find 高亮除外）', () => {
    let rulesOnly = cleanCss
    for (const pattern of [
      /^@theme\s*\{/m,
      /^html\[data-theme='[\w-]+'\]\s*\{/m,
      /^::highlight\(chat-find-[\w-]+\)\s*\{/m
    ]) {
      rulesOnly = removeAllBlocks(rulesOnly, pattern)
    }
    const leftovers = [...rulesOnly.matchAll(/rgb\(255 255 255 \//g)].map((match) => match[0])
    expect(leftovers).toEqual([])
  })

  it('chat-find 高亮保持有意字面量（琥珀色，不随主题翻转）', () => {
    const current = blockFor(cleanCss, /^::highlight\(chat-find-current\)\s*\{/m)
    expect(current).toContain('rgb(245 223 128 / 82%)')
    expect(current).toContain('#241f10')
  })

  it('--chat-muted / --chat-subtle 由 --color-fg-max 派生', () => {
    expect(css).toMatch(
      /--chat-muted:\s*color-mix\(in srgb, var\(--color-fg-max\) 42%, transparent\)/
    )
    expect(css).toMatch(
      /--chat-subtle:\s*color-mix\(in srgb, var\(--color-fg-max\) 25%, transparent\)/
    )
  })

  /**
   * 亮色里 *-soft 状态色是「正文/状态文案」色（text-warn-soft、text-danger-soft 等），
   * 不像暗色那样只是 primary 的提亮档，所以方向反过来：soft 必须比同族 primary 更深，
   * 且在白底上达到 WCAG AA 的 4.5:1。A 组实测 bg-warn/25、bg-warn/8 这类淡色底上的
   * 文字对比度只有 2.7~3.0，就是 soft 太浅导致的，warn-soft 因此改取 amber-800。
   */
  it('每个亮色主题的 soft 状态色都比 primary 更深，且在自己的画布上可读（≥4.5:1）', () => {
    for (const theme of THEMES.filter((entry) => entry.appearance === 'light')) {
      const block = themeBlocks.get(theme.id)
      for (const family of ['warn', 'success', 'danger', 'info']) {
        const primary = hexToken(family, block)
        const soft = hexToken(`${family}-soft`, block)
        expect(primary, `${theme.id} --color-${family}`).not.toBeNull()
        expect(soft, `${theme.id} --color-${family}-soft`).not.toBeNull()
        expect(
          contrastRatio(soft, theme.canvas),
          `${theme.id} --color-${family}-soft ${soft} 画布对比度`
        ).toBeGreaterThanOrEqual(4.5)
        expect(
          contrastRatio(soft, theme.canvas),
          `${theme.id} --color-${family}-soft 应比 --color-${family} 更深（亮色方向与暗色相反）`
        ).toBeGreaterThan(contrastRatio(primary, theme.canvas))
      }
    }
  })

  /**
   * 深色主题也要能读：正文（--color-fg）在自己的画布上至少到 AA 的 7:1（正文级），
   * 次级文字（--color-fg-muted）至少 3:1。Catppuccin 的 overlay 档很淡，压深不够就会
   * 出现「深色主题里过程文字几乎看不见」。
   */
  it('每个主题的前景阶梯在自己的画布上可读', () => {
    for (const theme of THEMES) {
      const block = themeBlocks.get(theme.id)
      const fg = hexToken('fg', block)
      const muted = hexToken('fg-muted', block)
      expect(fg, `${theme.id} --color-fg`).not.toBeNull()
      expect(muted, `${theme.id} --color-fg-muted`).not.toBeNull()
      expect(contrastRatio(fg, theme.canvas), `${theme.id} 正文对比度`).toBeGreaterThanOrEqual(7)
      expect(
        contrastRatio(muted, theme.canvas),
        `${theme.id} 次级文字对比度`
      ).toBeGreaterThanOrEqual(3)
    }
  })

  it('固定黑遮罩 / 彩色实心底上的白 alpha 用 #fff 表达（两种主题都保持白）', () => {
    // 图片查看器压在固定黑遮罩上
    expect(ruleBody('.chat-image-preview img')).toContain(
      'color-mix(in srgb, #fff 18%, transparent)'
    )
    expect(ruleBody('.chat-image-preview-path')).toContain(
      'color-mix(in srgb, #fff 52%, transparent)'
    )
    // 主操作按钮改由共享控件库提供（`Button variant="accent"`）：实心底上的字色跟着
    // `--accent-contrast` 翻转，暗色橙底深字、亮色蓝底白字，同样不写死白色。
    expect(CONFIG_UI_CSS).toContain('color: var(--accent-contrast)')
    expect(CONFIG_UI_CSS).toContain('--accent-contrast: #1e1f22')
    expect(CONFIG_UI_CSS).toContain('--accent-contrast: #ffffff')
  })

  it('快速选择选中行与会话行共用 --color-active，不再是实心蓝底白字', () => {
    const selected = ruleBody('.quick-pick-row.is-selected')
    expect(selected).toContain('background: var(--color-active)')
    expect(selected).toContain('color: var(--color-fg-max)')
    expect(selected).not.toContain('#fff')
    // 次要文字跟着前景色稀释，两种主题下都不写死白
    expect(ruleBody('.quick-pick-row.is-selected .quick-pick-row-detail')).toContain(
      'color-mix(in srgb, var(--color-fg-max) 68%, transparent)'
    )
  })

  /**
   * 提问（ask）的识别色是主题强调色之外的一支：青色。它同时画在卡片的问号徽标、
   * 选中选项、「确定」按钮与侧栏「等你选」圆点上——和主按钮、未读蓝点、运行绿点
   * 混成一片，就等于「这卡没被一眼认出来」。
   *
   * 字色压在青底上，必须跟着主题明暗翻转（暗色主题青底压深字、亮色主题深青压白字），
   * 写死一个近黑在 `light` / `latte` / `tokyo-night-light` 上就读不出来。
   */
  it('提问卡片的识别色是独立的 --color-ask，字色在每个主题上可读', () => {
    for (const selector of ['.chat-ask-mark', '.chat-ask-submit']) {
      const body = ruleBody(selector)
      expect(body, `${selector} 存在`).not.toBeNull()
      expect(body, `${selector} 底色用 --color-ask`).toContain('background: var(--color-ask)')
      expect(body, `${selector} 字色用 --color-ask-contrast`).toContain(
        'color: var(--color-ask-contrast)'
      )
    }

    for (const theme of THEMES) {
      const block = themeBlocks.get(theme.id)
      const ask = hexToken('ask', block)
      const contrast = hexToken('ask-contrast', block)
      expect(ask, `${theme.id} --color-ask`).not.toBeNull()
      expect(contrast, `${theme.id} --color-ask-contrast`).not.toBeNull()
      expect(
        contrastRatio(contrast, ask),
        `${theme.id} --color-ask 实心底上的字色对比度`
      ).toBeGreaterThanOrEqual(4.5)
      // 与主题强调色同值就失去区分意义（Catppuccin 的 accent 本身就是紫/青系）。
      expect(ask, `${theme.id} --color-ask 不能等于 --color-accent`).not.toBe(
        hexToken('accent', block)
      )
    }
  })

  /**
   * 侧栏会话行与快速打开里的「等你做一个选择」必须跟着用同一支青：
   * 它原本和「未读」共用强调色，浅色主题下两个蓝点只能靠透明度分辨。
   */
  it('侧栏与快速打开的等待选择圆点用 bg-ask，不再借用 accent / info', () => {
    for (const file of ['SessionTree.jsx', 'SessionQuickOpen.jsx']) {
      const source = readFileSync(resolve(RENDERER_DIR, file), 'utf8')
      const awaitingBlocks = [...source.matchAll(/awaiting[\s\S]{0,200}/g)].map((match) =>
        match[0]
      )
      expect(awaitingBlocks.length, `${file} 里应当有 awaiting 分支`).toBeGreaterThan(0)
      expect(
        source.match(/bg-accent[^\n]*chat-dot-unread/g),
        `${file} 的等待点不能再用 bg-accent`
      ).toBeNull()
      expect(source, `${file} 的等待点用 bg-ask`).toContain('bg-ask')
    }
  })

  it('亮色主题给每个重阴影配了同选择器的更轻阴影，暗色原值保持不动', () => {
    const shadowedRules = [
      '.chat-tooltip',
      '.chat-selection-bar',
      '.chat-jump',
      '.chat-find',
      '.chat-command-palette',
      '.chat-popover',
      '.chat-image-preview img',
      '.chat-modal',
      '.chat-btw-jump',
      '.quick-pick-panel',
      '.chat-ask-card.is-modal'
    ]

    for (const selector of shadowedRules) {
      const darkAlpha = shadowAlpha(ruleBody(selector))
      expect(darkAlpha, `${selector} 暗色阴影`).not.toBeNull()
      expect(darkAlpha, `${selector} 暗色阴影`).toBeGreaterThanOrEqual(35)

      const lightBody = ruleBody(selector, { light: true })
      expect(lightBody, `${selector} 亮色阴影覆盖`).not.toBeNull()
      const lightAlpha = shadowAlpha(lightBody)
      expect(lightAlpha, `${selector} 亮色阴影`).not.toBeNull()
      expect(lightAlpha, `${selector} 亮色阴影`).toBeGreaterThanOrEqual(10)
      expect(lightAlpha, `${selector} 亮色阴影`).toBeLessThanOrEqual(18)
    }
  })

  it('亮色主题替换查找条输入框的黑色内凹底', () => {
    expect(ruleBody('.chat-find-field')).toContain('rgb(0 0 0 / 28%)')
    expect(ruleBody('.chat-find-field', { light: true })).toContain(
      'background: var(--color-canvas)'
    )
  })

  /**
   * 亮色主题的取值来自 DSH（deepseek-harness）的 `--dsw-static-*` / `--dsw-alias-*`
   * 调色板。这几个是最容易被「看着调一下」改走的锚点，钉死它们：
   * 正文与菜单是 label-primary（近黑），不是中灰；用户消息带是 deepseek-50 淡蓝；
   * 面板是 neutral-bluish-50，选中行是 neutral-bluish-100。
   */
  it('亮色锚点取 DSH 的 label / surface 档位', () => {
    expect(lightHexToken('panel')).toBe('#f9fafb') // neutral-bluish-50
    expect(lightHexToken('active')).toBe('#ebeef2') // neutral-bluish-100
    expect(lightHexToken('fg-max')).toBe('#0f1115') // label-primary
    // 正文也是 label-primary：DSH 的 label 阶梯里没有比它更深的正文档，
    // 亮色顶端两档因此并成同一个值（暗色里 #fff / #d4d4d4 仍然分开）。
    expect(lightHexToken('fg-strong')).toBe('#0f1115') // label-primary
    expect(lightHexToken('fg')).toBe('#1b1b1c') // neutral-bluish-900 — 正文
    expect(lightHexToken('nav-fg')).toBe('#0f1115') // 侧栏/菜单 = label-primary
    expect(lightHexToken('bubble')).toBe('#edf3fe') // --dsw-specific-bubble
    expect(lightHexToken('inline-code-bg')).toBe('#fafafa') // markdown-inline-code
    expect(lightHexToken('heat-empty')).toBe('#ebeef2') // neutral-bluish-100
  })

  it('菜单文字有专属 token，侧栏不得回退成中灰的 fg-soft', () => {
    expect(themeBlock).toContain('--color-nav-fg:')
    for (const token of [
      '--color-bubble:',
      '--color-inline-code:',
      '--color-inline-code-bg:',
      '--color-inline-code-border:'
    ]) {
      expect(themeBlock).toContain(token)
      // 每个主题都自带这一组「按主题性格走」的 token（覆盖检查在第一个用例里，这里只点名）。
      for (const [id, block] of themeBlocks) expect(block, `${id} ${token}`).toContain(token)
    }

    const offenders = []
    for (const file of ['SessionTree.jsx', 'App.jsx']) {
      const source = readFileSync(resolve(RENDERER_DIR, file), 'utf8')
      source.split('\n').forEach((line, index) => {
        // 行文本就是「这是菜单/会话行」的判定：带 text-fg-soft 的 className 必须换成 nav-fg
        if (/text-\[13px\]|text-sm/.test(line) && line.includes('text-fg-soft')) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('用户消息带与亮色次级文字接到各自的 token', () => {
    expect(css).toMatch(/--chat-user:\s*var\(--color-bubble\)/)
    expect(css).toMatch(
      /html\[data-appearance='light'\] \.chat-view,[\s\S]{0,120}--chat-muted:\s*var\(--color-fg-dim\)/
    )
  })

  /**
   * 过程文字（工具行、思考、时间戳）在 DSH 里是 label-tertiary：比正文低两档，
   * 「做过什么」退到背景里、只有回答留在前景。取 label-secondary 会明显比 DeepSeek 重。
   */
  it('亮色过程文字取 label-tertiary，不跟着正文走', () => {
    const body = blockFor(
      cleanCss,
      /^html\[data-appearance='light'\] \.chat-view,\s*\nhtml\[data-appearance='light'\] \.chat-modal-overlay\s*\{/m
    )
    expect(body).not.toBeNull()
    expect(body).toContain('--chat-muted: var(--color-fg-dim)')
    expect(body).toContain('--chat-subtle: var(--color-fg-faint)')
  })

  /**
   * 选中行用 --color-active（DSH 的 neutral-bluish-100 / tab.activeBackground），
   * 不是 10% 的洗色层：亮色下洗色层压出来是 #e2e6e9，比 DeepSeek 的选中行更重、更脏。
   */
  it('会话行、导航项与文件树选中态用 --color-active，不用洗色层', () => {
    const offenders = []
    const selected = /bg-overlay-strong/
    for (const [file, pattern] of [
      ['SessionTree.jsx', /active \? '([^']*)' : /g],
      ['FileSidePanels.jsx', /selected \? '([^']*)' : /g]
    ]) {
      const source = readFileSync(resolve(RENDERER_DIR, file), 'utf8')
      for (const match of source.matchAll(pattern)) {
        if (selected.test(match[1])) offenders.push(`${file}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])

    for (const file of ['SessionTree.jsx', 'App.jsx', 'FileSidePanels.jsx']) {
      expect(readFileSync(resolve(RENDERER_DIR, file), 'utf8')).toContain('bg-active')
    }
  })

  /**
   * 亮色热力图的「没有活动」格子不能是 canvas：纯白铺在 #f9fafb 的卡片上等于没有网格。
   * 暗色沿用 canvas 的深度，所以只钉 token 存在与亮色取值。
   */
  it('热力图空格用专属 token，不再拿 canvas 顶替', () => {
    expect(themeBlock).toContain('--color-heat-empty:')
    for (const [id, block] of themeBlocks) expect(block, id).toContain('--color-heat-empty:')
    const stats = readFileSync(resolve(RENDERER_DIR, 'stats/StatsView.jsx'), 'utf8')
    expect(stats).toContain("'var(--color-heat-empty)'")
    expect(stats).not.toMatch(/CALENDAR_RAMP = \[\s*'var\(--color-canvas\)'/)
  })

  /**
   * 亮底上的 ANSI bright 色不能比本色更浅：`#f25a5a` 这类亮红在白色终端上只剩 2.9:1，
   * ls / git 的强调色反而糊掉。彩色档保持本色，只有黑白两对走灰度阶梯。
   *
   * 表在 `terminal-theme.js`（主窗口与终端控制窗口共用一份），逐个亮色主题校验。
   */
  it('亮色终端的彩色 bright 档不比本色更浅（白底可读）', () => {
    const source = readFileSync(resolve(RENDERER_DIR, 'terminal-theme.js'), 'utf8')
    for (const theme of THEMES.filter((entry) => entry.appearance === 'light')) {
      const constName = TERMINAL_CONSTANTS[theme.id]
      const body = blockFor(source, new RegExp(`const ${constName} = \\{`))
      expect(body, `${theme.id} 的终端调色板`).not.toBeNull()
      const value = (key) => {
        const match = new RegExp(`\\b${key}: '(#[0-9a-fA-F]{6})'`).exec(body)
        return match ? match[1].toLowerCase() : null
      }
      for (const name of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']) {
        const base = value(name)
        const bright = value(`bright${name[0].toUpperCase()}${name.slice(1)}`)
        expect(base, `${theme.id} ${name}`).not.toBeNull()
        expect(bright, `${theme.id} bright${name}`).toBe(base)
        expect(
          contrastRatio(base, theme.canvas),
          `${theme.id} ${name} 画布对比度`
        ).toBeGreaterThanOrEqual(4.2)
      }
    }
  })

  /**
   * 三处「非 CSS」的消费者必须逐主题对齐 app.css：终端的 xterm 表、终端窗口的外壳色、
   * 以及每个主题自己的画布色。少一处就会出现「切到某主题后终端仍是上一套颜色」。
   */
  it('终端与终端窗口按主题对齐 app.css 的 canvas / panel / line / fg', () => {
    const terminalSource = readFileSync(resolve(RENDERER_DIR, 'terminal-theme.js'), 'utf8')
    const pageCss = readFileSync(resolve(RENDERER_DIR, 'terminal-page.css'), 'utf8')

    for (const theme of THEMES) {
      const block = themeBlocks.get(theme.id)
      const token = (name) => {
        const match = new RegExp(`--color-${name}:\\s*([^;]+);`).exec(block)
        return match ? match[1].trim() : null
      }

      // xterm：背景与前景跟着画布和正文走。
      const table = blockFor(terminalSource, new RegExp(`const ${TERMINAL_CONSTANTS[theme.id]} = \\{`))
      expect(table, `${theme.id} 缺少 xterm 调色板`).not.toBeNull()
      expect(table).toContain(`background: '${theme.canvas}'`)
      const terminalFg = /foreground: '(#[0-9a-f]{6})'/.exec(table)
      expect(terminalFg, `${theme.id} xterm foreground`).not.toBeNull()
      expect(
        contrastRatio(terminalFg[1], theme.canvas),
        `${theme.id} xterm 前景在画布上不可读`
      ).toBeGreaterThanOrEqual(4.5)

      // 终端窗口外壳：深色主题走 :root 默认值，其余每个主题一个块。
      const shell = blockFor(pageCss, new RegExp(`^html\\[data-theme='${theme.id}'\\] \\{`, 'm'))
      if (theme.id === 'dark') {
        expect(blockFor(pageCss, /^:root \{/m)).toContain(`--terminal-bg: ${theme.canvas};`)
        continue
      }
      expect(shell, `${theme.id} 缺少终端窗口配色块`).not.toBeNull()
      expect(shell).toContain(`--terminal-bg: ${theme.canvas};`)
      expect(shell).toContain(`--terminal-panel: ${token('panel')};`)
      const shellFg = /--terminal-fg:\s*(#[0-9a-f]{6});/.exec(shell)
      expect(shellFg, `${theme.id} --terminal-fg`).not.toBeNull()
      expect(
        contrastRatio(shellFg[1], theme.canvas),
        `${theme.id} 终端窗口正文在画布上不可读`
      ).toBeGreaterThanOrEqual(4.5)
    }
  })
})
