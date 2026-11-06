/**
 * 受控浏览器窗口顶部那条 chrome（标签条 + 只读地址）。
 *
 * 它被加载进窗口自己的 webContents，**没有 preload**：状态由主进程用
 * `executeJavaScript('window.__micaChrome.update(...)')` 推进来，页面上的点击则通过
 * `console.log('__mica_chrome__' + JSON.stringify({...}))` 回到主进程（见
 * browser-manager.js 的 chrome 消息处理）—— 这样不必为了一个只读工具条给整个应用加
 * preload。所有来自主进程的数据都只用 textContent 落地，不做 innerHTML 拼接。
 *
 * 配色**跟随应用主题**：外壳每次推状态都带上当前主题的调色板（`chromePalette()`），
 * 页面只需要把 `--c-*` 变量换掉。取值与 apps/desktop/src/renderer/assets/app.css 里的
 * 主题块一一对齐，改主题时两处必须一起改（`browser-chrome.test.js` 逐档比对）。
 */

export const CHROME_MESSAGE_PREFIX = '__mica_chrome__'

/**
 * 每个主题的 chrome 调色板。键与 ui-state 里的主题 id 一致，取值按下面的对应关系从
 * app.css 抄过来：panel = --color-panel、canvas = --color-canvas（地址框）、
 * active = --color-active（当前标签页）、line = --color-line、fg = --color-fg、
 * fgSoft = --color-fg-soft、fgDim = --color-fg-dim（次要文案与提示）、
 * warn = --color-warn-soft（受控徽标与加载点）、overlay = --color-overlay（悬浮层）。
 */
const PALETTES = {
  dark: {
    panel: '#3c3f41',
    canvas: '#2b2b2b',
    active: '#515658',
    line: '#4b4b4b',
    fg: '#cccccc',
    fgSoft: '#a1a1a1',
    fgDim: '#888888',
    warn: '#d7ba7d',
    overlay: 'rgb(255 255 255 / 6%)'
  },
  light: {
    panel: '#f9fafb',
    canvas: '#ffffff',
    active: '#ebeef2',
    line: '#0000001a',
    fg: '#1b1b1c',
    fgSoft: '#43454a',
    fgDim: '#81858c',
    warn: '#92400e',
    overlay: 'rgb(38 49 72 / 6%)'
  },
  mocha: {
    panel: '#181825',
    canvas: '#1e1e2e',
    active: '#313244',
    line: '#45475a',
    fg: '#bac2de',
    fgSoft: '#a6adc8',
    fgDim: '#7f849c',
    warn: '#fab387',
    overlay: 'rgb(255 255 255 / 6%)'
  },
  latte: {
    panel: '#e6e9ef',
    canvas: '#eff1f5',
    active: '#ccd0da',
    line: '#bcc0cc',
    fg: '#4c4f69',
    fgSoft: '#5c5f77',
    fgDim: '#7c7f93',
    warn: '#7d5010',
    overlay: 'rgb(76 79 105 / 6%)'
  },
  'tokyo-night': {
    panel: '#16161e',
    canvas: '#1a1b26',
    active: '#202330',
    line: 'rgb(84 92 126 / 30%)',
    fg: '#a9b1d6',
    fgSoft: '#9aa5ce',
    fgDim: '#565f89',
    warn: '#ff9e64',
    overlay: 'rgb(255 255 255 / 6%)'
  },
  'tokyo-night-light': {
    panel: '#d6d8df',
    canvas: '#e6e7ed',
    active: '#c1c4cf',
    line: '#c1c2c7',
    fg: '#363c4d',
    fgSoft: '#40434f',
    fgDim: '#707280',
    warn: '#754d11',
    overlay: 'rgb(52 59 88 / 6%)'
  }
}

/** 主题 id → chrome 调色板。未登记的主题（含 undefined）回落到默认深色。 */
export function chromePalette(theme) {
  return PALETTES[theme] ?? PALETTES.dark
}

export function chromeHtml() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<style>
  /* 默认值 = Darcula：第一次 update 到达前的那一帧用它们，其余主题由 applyPalette 覆盖 */
  :root {
    --c-panel: #3c3f41; --c-canvas: #2b2b2b; --c-active: #515658; --c-line: #4b4b4b;
    --c-fg: #cccccc; --c-fg-soft: #a1a1a1; --c-fg-dim: #888888;
    --c-warn: #d7ba7d; --c-overlay: rgb(255 255 255 / 6%);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; align-items: center; gap: 8px;
    height: 38px; padding: 0 10px;
    background: var(--c-panel); color: var(--c-fg);
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    border-bottom: 1px solid var(--c-line);
    -webkit-user-select: none; user-select: none;
    -webkit-app-region: drag;
  }
  .badge {
    display: flex; align-items: center; gap: 6px; flex: 0 1 auto; min-width: 0; max-width: 24%;
    padding: 3px 8px; border-radius: 6px; background: var(--c-overlay);
    color: var(--c-fg-soft); font-weight: 500;
  }
  #label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { flex: none; width: 5px; height: 5px; border-radius: 999px; background: var(--c-fg-dim); }
  .dot.loading { background: var(--c-warn); }
  .windows {
    flex: none; padding: 4px 8px; border: 1px solid var(--c-line); border-radius: 6px;
    background: var(--c-active); color: var(--c-fg); font: inherit; cursor: pointer;
    -webkit-app-region: no-drag;
  }
  .windows:hover { background: var(--c-overlay); }
  .windows:focus-visible { outline: 1px solid var(--c-fg-soft); }
  .windows[hidden] { display: none; }
  .tabs { display: flex; align-items: center; gap: 3px; min-width: 0; max-width: 40%; overflow-x: auto; scrollbar-width: none; -webkit-app-region: no-drag; }
  .tabs::-webkit-scrollbar { display: none; }
  .page-title { flex: 0 1 auto; min-width: 0; max-width: 190px; padding: 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab {
    display: flex; align-items: center; justify-content: center; flex: 0 0 auto; min-width: 26px; max-width: 190px;
    padding: 4px 9px; border: 0; border-radius: 6px; background: transparent; color: var(--c-fg-dim); font: inherit;
    cursor: default; white-space: nowrap; overflow: hidden;
  }
  .tab:hover { background: var(--c-overlay); color: var(--c-fg); }
  .tab.active { background: var(--c-active); color: var(--c-fg); }
  .tab:focus-visible { outline: 1px solid var(--c-fg-soft); outline-offset: -1px; }
  .tab .title { overflow: hidden; text-overflow: ellipsis; }
  .url {
    flex: 1 1 auto; min-width: 0; padding: 3px 10px; border-radius: 6px;
    background: var(--c-canvas); border: 1px solid var(--c-line); color: var(--c-fg-soft);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: ltr; text-align: left;
    /* 地址要能选中复制：它落在窗口的拖动区里，所以两样都得单独放开 */
    cursor: text; -webkit-user-select: text; user-select: text; -webkit-app-region: no-drag;
  }
</style>
</head>
<body>
  <span class="badge" id="badge"><span class="dot" id="loading"></span><span id="label">受控浏览器</span></span>
  <button class="windows" id="windows" type="button" hidden></button>
  <span class="tabs" id="tabs"></span>
  <span class="url" id="url" title=""></span>
<script>
  (function () {
    var label = document.getElementById('label')
    var badge = document.getElementById('badge')
    var windows = document.getElementById('windows')
    var tabs = document.getElementById('tabs')
    var url = document.getElementById('url')
    var loading = document.getElementById('loading')
    var root = document.documentElement
    var PALETTE_VARS = {
      panel: '--c-panel',
      canvas: '--c-canvas',
      active: '--c-active',
      line: '--c-line',
      fg: '--c-fg',
      fgSoft: '--c-fg-soft',
      fgDim: '--c-fg-dim',
      warn: '--c-warn',
      overlay: '--c-overlay'
    }

    function send(action, payload) {
      console.log('${CHROME_MESSAGE_PREFIX}' + JSON.stringify(Object.assign({ action: action }, payload || {})))
    }

    windows.addEventListener('click', function () { send('showWindows') })

    function selectionText() {
      var selection = window.getSelection && window.getSelection()
      return selection ? String(selection) : ''
    }

    function applyPalette(palette) {
      if (!palette) return
      Object.keys(PALETTE_VARS).forEach(function (key) {
        if (palette[key]) root.style.setProperty(PALETTE_VARS[key], palette[key])
      })
    }

    // 点一下选整条地址（已经手动选过就不动它），再 ⌘C / Ctrl+C 复制。复制走主进程的
    // 剪贴板：这条顶栏是 data: URL，不指望渲染进程自己的复制权限。
    url.addEventListener('click', function () {
      if (selectionText()) return
      var selection = window.getSelection && window.getSelection()
      if (!selection) return
      var range = document.createRange()
      range.selectNodeContents(url)
      selection.removeAllRanges()
      selection.addRange(range)
    })

    document.addEventListener('keydown', function (event) {
      if (!(event.metaKey || event.ctrlKey) || String(event.key).toLowerCase() !== 'c') return
      var text = selectionText()
      if (!text) return
      event.preventDefault()
      send('copy', { text: text })
    })

    // Electron 默认不给页面右键菜单，所以右键不弹「复制」：有选中就复制选中的，没有就
    // 直接复制整条地址
    document.addEventListener('contextmenu', function (event) {
      var text = selectionText() || (event.target === url ? url.textContent : '')
      if (!text) return
      event.preventDefault()
      send('copy', { text: text })
    })

    window.__micaChrome = {
      update: function (state) {
        state = state || {}
        applyPalette(state.palette)
        label.textContent = (state.incognito ? '无痕 · ' : '') + (state.label || '受控浏览器')
        badge.title = label.textContent + (state.owner ? '\\n用户会话 ' + state.owner : '\\n未归属')
        var count = Number(state.windowCount) || 0
        windows.hidden = count < 2
        windows.textContent = '窗口 ' + count + ' ▾'
        windows.title = '切换浏览器窗口（共 ' + count + ' 个）'
        windows.setAttribute('aria-label', windows.title)
        url.textContent = state.url || 'about:blank'
        url.title = url.textContent + '\\n地址由 Mica 控制，不可编辑；可选中复制'
        loading.className = state.loading ? 'dot loading' : 'dot'
        tabs.textContent = ''
        var list = state.tabs || []
        var sharedTitle = list.length > 1 && list[0].title && list.every(function (tab) { return tab.title === list[0].title })
        if (sharedTitle) {
          var heading = document.createElement('span')
          heading.className = 'page-title'
          heading.textContent = list[0].title
          heading.title = list[0].title
          tabs.appendChild(heading)
        }
        if (list.length > 1) {
          list.forEach(function (tab, index) {
            var node = document.createElement('button')
            node.type = 'button'
            node.className = tab.active ? 'tab active' : 'tab'
            node.title = (tab.title || '新标签页') + '\\n' + (tab.url || '')
            node.setAttribute('aria-label', '标签页 ' + (index + 1) + '：' + (tab.title || '新标签页'))
            node.setAttribute('aria-pressed', String(Boolean(tab.active)))
            var title = document.createElement('span')
            title.className = 'title'
            title.textContent = sharedTitle ? String(index + 1) : (tab.title || '新标签页')
            node.appendChild(title)
            node.addEventListener('click', function () { send('activateTab', { tabId: tab.id }) })
            tabs.appendChild(node)
          })
          return
        }
        // 单标签页时标签条没有信息量，把标题放在左边就够
        if (list.length === 1) {
          var single = document.createElement('span')
          single.className = 'page-title'
          single.title = list[0].title || '新标签页'
          var text = document.createElement('span')
          text.className = 'title'
          text.textContent = list[0].title || '新标签页'
          single.appendChild(text)
          tabs.appendChild(single)
        }
      }
    }
  })()
</script>
</body>
</html>`
}

export function chromeDataUrl() {
  return `data:text/html;charset=utf-8,${encodeURIComponent(chromeHtml())}`
}

/** 解析 chrome 页回传的控制消息；不是我们的消息就返回 null（由调用方决定要不要吞掉日志） */
export function parseChromeMessage(message) {
  const raw = String(message || '')
  if (!raw.startsWith(CHROME_MESSAGE_PREFIX)) return null
  try {
    const parsed = JSON.parse(raw.slice(CHROME_MESSAGE_PREFIX.length))
    if (!parsed || typeof parsed.action !== 'string') return null
    return parsed
  } catch {
    return null
  }
}
