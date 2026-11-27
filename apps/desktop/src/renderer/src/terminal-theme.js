/**
 * xterm 的调色板：xterm 读不到 CSS 变量，只能按主题名查一张表。
 *
 * 这张表是「只有运行时才需要的颜色」的唯一来源——主窗口的终端面板（TerminalHost.jsx）与
 * 独立的终端控制窗口（terminal-page.jsx）都从这里取，不要再各抄一份。
 *
 * 每一档的取值与 `assets/app.css` 里同 id 的 `html[data-theme='<id>']` 块对齐：
 * background = --color-canvas、foreground = --color-fg、cursor = --color-fg-max、
 * ANSI 彩色 = 该主题调色板的终端色。漏对齐会由 `theme-tokens.test.js` 抓到。
 */

const DARK = {
  background: '#2b2b2b',
  foreground: '#a9b7c6',
  cursor: '#a9b7c6',
  selectionBackground: 'rgba(33, 66, 131, 0.6)',
  black: '#3c3f41',
  red: '#ff6b68',
  green: '#a8c023',
  yellow: '#d6bf55',
  blue: '#5394ec',
  magenta: '#ae8abe',
  cyan: '#299999',
  white: '#bababa',
  brightBlack: '#606366',
  brightRed: '#ff8785',
  brightGreen: '#a8c023',
  brightYellow: '#ffff00',
  brightBlue: '#7eaef1',
  brightMagenta: '#ff99ff',
  brightCyan: '#6cdada',
  brightWhite: '#ffffff'
}

/* 亮色终端：内容面 --color-canvas #ffffff、正文 --color-fg #2c2c2e、光标
   --color-fg-max #0f1115、选中 --color-accent 的 22%；ANSI 用亮色状态 token。
   亮底上没有「更亮一档」的余地：bright* 若继续往浅里走，白底对比度会掉到 3:1 以下
   （#f25a5a 2.9、#dd8629 2.8），ls / git / npm 的强调色反而看不清。与 VS Code 的
   Light+ 一致：彩色档保持本色，只有黑白两对继续走灰度阶梯。 */
const LIGHT = {
  background: '#ffffff',
  foreground: '#2c2c2e',
  cursor: '#0f1115',
  selectionBackground: 'rgba(65, 118, 230, 0.22)',
  black: '#0f1115',
  red: '#ec1313',
  green: '#2b8a3e',
  yellow: '#b45309',
  blue: '#4176e6',
  magenta: '#6741d9',
  cyan: '#0f766e',
  white: '#81858c',
  brightBlack: '#61666b',
  brightRed: '#ec1313',
  brightGreen: '#2b8a3e',
  brightYellow: '#b45309',
  brightBlue: '#4176e6',
  brightMagenta: '#6741d9',
  brightCyan: '#0f766e',
  brightWhite: '#979da6'
}

/* Catppuccin Mocha / Latte：ANSI 取 Catppuccin 官方调色板的 terminal 映射
   （red/green/yellow/blue/pink/sky，黑白两对走 surface/subtext 阶梯）。 */
const MOCHA = {
  background: '#1e1e2e',
  foreground: '#bac2de',
  cursor: '#cdd6f4',
  selectionBackground: 'rgba(255, 255, 255, 0.15)',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#f5c2e7',
  cyan: '#94e2d5',
  white: '#a6adc8',
  brightBlack: '#585b70',
  brightRed: '#f37799',
  brightGreen: '#89d88b',
  brightYellow: '#ebd391',
  brightBlue: '#74a8fc',
  brightMagenta: '#f2aede',
  brightCyan: '#6bd7ca',
  brightWhite: '#bac2de'
}

const LATTE = {
  background: '#eff1f5',
  foreground: '#4c4f69',
  cursor: '#4c4f69',
  selectionBackground: 'rgba(76, 79, 105, 0.14)',
  black: '#5c5f77',
  red: '#d20f39',
  // 官方色板在 #eff1f5 上只有 2.9 左右，按同一色相压暗到 4.5 再落地。
  green: '#327d22',
  yellow: '#986114',
  blue: '#1d62eb',
  magenta: '#9f508a',
  cyan: '#13787d',
  white: '#6c6f85',
  brightBlack: '#6c6f85',
  // 亮底上 bright 档不再提亮（与 Light+ 同一个理由），只保留黑白的灰度递进。
  brightRed: '#d20f39',
  brightGreen: '#327d22',
  brightYellow: '#986114',
  brightBlue: '#1d62eb',
  brightMagenta: '#9f508a',
  brightCyan: '#13787d',
  brightWhite: '#5c5f77'
}

/* Tokyo Night 的 terminal.ansi* 原样照搬（它自己就把 bright 档设成与本色同值，
   只有 white / brightBlack 参与灰度阶梯）。 */
const TOKYO_NIGHT = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  selectionBackground: 'rgba(255, 255, 255, 0.15)',
  black: '#363b54',
  red: '#f7768e',
  green: '#73daca',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#787c99',
  brightBlack: '#363b54',
  brightRed: '#f7768e',
  brightGreen: '#73daca',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#acb0d0'
}

const TOKYO_NIGHT_LIGHT = {
  background: '#e6e7ed',
  foreground: '#363c4d',
  cursor: '#343b58',
  selectionBackground: 'rgba(52, 59, 88, 0.14)',
  black: '#343b58',
  red: '#8c4351',
  green: '#33635c',
  yellow: '#8f5e15',
  blue: '#2959aa',
  magenta: '#7b43ba',
  cyan: '#006c86',
  white: '#707280',
  brightBlack: '#707280',
  brightRed: '#8c4351',
  brightGreen: '#33635c',
  brightYellow: '#8f5e15',
  brightBlue: '#2959aa',
  brightMagenta: '#7b43ba',
  brightCyan: '#006c86',
  brightWhite: '#40434f'
}

/** 主题 id → xterm options.theme。未登记的主题回落到默认深色。 */
export const TERMINAL_THEMES = {
  dark: DARK,
  light: LIGHT,
  mocha: MOCHA,
  latte: LATTE,
  'tokyo-night': TOKYO_NIGHT,
  'tokyo-night-light': TOKYO_NIGHT_LIGHT
}

export function terminalThemeFor(theme) {
  return TERMINAL_THEMES[theme] ?? DARK
}
