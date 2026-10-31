import { describe, expect, it } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 颜色主题契约测试：`assets/app.css` 是渲染层唯一的颜色来源。
 *
 * 主题切换只改 `<html data-theme>`，所以两条硬约束：
 * - `@theme` 里每个语义色都要有 `html[data-theme='light']` 覆盖，否则亮色下漏成暗色值；
 * - 规则里不许再出现 `rgb(255 255 255 / N%)` 这种写死的白色 alpha——它必须写成
 *   `color-mix(in srgb, var(--color-fg-max) N%, transparent)`，亮色里才会自动变黑。
 *
 * 例外只有两类，都在下面显式放行：`@theme` / 亮色块自己的 token 定义（它们就是字面量），
 * 以及 `::highlight(chat-find-*)` 的命中高亮（琥珀色固定，不随主题变）。注释里的颜色说明
 * 不算残留。
 */
const CSS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../assets/app.css')
const css = readFileSync(CSS_PATH, 'utf8')

const RENDERER_DIR = resolve(dirname(fileURLToPath(import.meta.url)))
const PLUGINS_DIR = resolve(RENDERER_DIR, '../../../../../plugins')

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

/** 定位一条顶层规则（可选限定在亮色主题前缀下）的声明体。 */
function ruleBody(selector, { light = false } = {}) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const prefix = light ? "html\\[data-theme='light'\\] " : ''
  return blockFor(stripComments(css), new RegExp(`^${prefix}${escaped} \\{`, 'm'))
}

const cleanCss = stripComments(css)
const themeBlock = blockFor(cleanCss, /^@theme\s*\{/m)
const lightBlock = blockFor(cleanCss, /^html\[data-theme='light'\]\s*\{/m)

/** 语义色 token 名（出现顺序去重）。 */
function colorTokens(block) {
  return [...new Set([...block.matchAll(/--color-[\w-]+(?=\s*:)/g)].map((match) => match[0]))]
}

/** 亮色块里某个 token 的 hex 值；不是 hex（如 color-mix）时返回 null。 */
function lightHexToken(name) {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(lightBlock ?? '')
  return match ? match[1].toLowerCase() : null
}

/** WCAG 相对亮度：只用来验证「白/近白底上的文字色」够不够黑。 */
function srgbChannel(value) {
  const channel = value / 255
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

/** 文字色与白底（#ffffff）的对比度。 */
function contrastOnWhite(hex) {
  const [r, g, b] = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16))
  const luminance = 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b)
  return 1.05 / (luminance + 0.05)
}

describe('app.css 颜色 token 主题契约', () => {
  it('@theme 的每个 --color-* 都在亮色主题块里有覆盖', () => {
    expect(themeBlock).not.toBeNull()
    expect(lightBlock).not.toBeNull()

    const darkTokens = colorTokens(themeBlock)
    const lightTokens = new Set(colorTokens(lightBlock))
    expect(darkTokens.length).toBeGreaterThan(30)
    expect(darkTokens.filter((token) => !lightTokens.has(token))).toEqual([])
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
      /^html\[data-theme='light'\]\s*\{/m,
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
  it('亮色 soft 状态色比 primary 更深且白底可读（≥4.5:1）', () => {
    for (const family of ['warn', 'success', 'danger', 'info']) {
      const primary = lightHexToken(family)
      const soft = lightHexToken(`${family}-soft`)
      expect(primary, `--color-${family}`).not.toBeNull()
      expect(soft, `--color-${family}-soft`).not.toBeNull()
      expect(
        contrastOnWhite(soft),
        `--color-${family}-soft ${soft} 白底对比度`
      ).toBeGreaterThanOrEqual(4.5)
      expect(
        contrastOnWhite(soft),
        `--color-${family}-soft 应比 --color-${family} 更深（亮色方向与暗色相反）`
      ).toBeGreaterThan(contrastOnWhite(primary))
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
    expect(ruleBody('.session-action-primary')).toContain('color: #fff')
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
      '.quick-pick-panel'
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
    expect(lightBlock).toContain('--color-nav-fg:')
    for (const token of [
      '--color-bubble:',
      '--color-inline-code:',
      '--color-inline-code-bg:',
      '--color-inline-code-border:'
    ]) {
      expect(themeBlock).toContain(token)
      expect(lightBlock).toContain(token)
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
      /html\[data-theme='light'\] \.chat-view,[\s\S]{0,120}--chat-muted:\s*var\(--color-fg-dim\)/
    )
  })

  /**
   * 过程文字（工具行、思考、时间戳）在 DSH 里是 label-tertiary：比正文低两档，
   * 「做过什么」退到背景里、只有回答留在前景。取 label-secondary 会明显比 DeepSeek 重。
   */
  it('亮色过程文字取 label-tertiary，不跟着正文走', () => {
    const body = blockFor(
      cleanCss,
      /^html\[data-theme='light'\] \.chat-view,\s*\nhtml\[data-theme='light'\] \.chat-modal-overlay\s*\{/m
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
    expect(lightBlock).toContain('--color-heat-empty:')
    const stats = readFileSync(resolve(RENDERER_DIR, 'stats/StatsView.jsx'), 'utf8')
    expect(stats).toContain("'var(--color-heat-empty)'")
    expect(stats).not.toMatch(/CALENDAR_RAMP = \[\s*'var\(--color-canvas\)'/)
  })

  /**
   * 亮底上的 ANSI bright 色不能比本色更浅：`#f25a5a` 这类亮红在白色终端上只剩 2.9:1，
   * ls / git 的强调色反而糊掉。彩色档保持本色，只有黑白两对走灰度阶梯。
   */
  it('亮色终端的彩色 bright 档不比本色更浅（白底可读）', () => {
    const source = readFileSync(resolve(RENDERER_DIR, 'TerminalHost.jsx'), 'utf8')
    const body = blockFor(source, /const LIGHT_TERMINAL_THEME = \{/)
    expect(body).not.toBeNull()
    const value = (key) => {
      const match = new RegExp(`\\b${key}: '(#[0-9a-fA-F]{6})'`).exec(body)
      return match ? match[1].toLowerCase() : null
    }
    for (const name of ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan']) {
      const base = value(name)
      const bright = value(`bright${name[0].toUpperCase()}${name.slice(1)}`)
      expect(base, name).not.toBeNull()
      expect(bright, `bright${name}`).toBe(base)
      expect(contrastOnWhite(base), `${name} 白底对比度`).toBeGreaterThanOrEqual(4.2)
    }
  })
})
