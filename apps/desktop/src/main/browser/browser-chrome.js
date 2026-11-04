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
    height: 38px; padding: 0 8px;
    background: var(--c-panel); color: var(--c-fg);
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    border-bottom: 1px solid var(--c-line);
    -webkit-user-select: none; user-select: none;
    -webkit-app-region: drag;
  }
  .badge {
    display: flex; align-items: center; gap: 6px; flex: none;
    padding: 2px 8px; border-radius: 999px; background: var(--c-overlay);
    color: var(--c-warn); font-weight: 600; letter-spacing: 0.02em;
  }
  .dot { width: 6px; height: 6px; border-radius: 999px; background: currentColor; }
  .owner { flex: none; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--c-fg-dim); }
  .tabs { display: flex; align-items: center; gap: 2px; min-width: 0; overflow: hidden; -webkit-app-region: no-drag; }
  .tab {
    display: flex; align-items: center; gap: 5px; max-width: 190px;
    padding: 3px 9px; border-radius: 6px 6px 0 0; color: var(--c-fg-dim);
    cursor: default; white-space: nowrap; overflow: hidden;
  }
  .tab:hover { background: var(--c-overlay); color: var(--c-fg); }
  .tab.active { background: var(--c-active); color: var(--c-fg); }
  .tab .title { overflow: hidden; text-overflow: ellipsis; }
  .grow { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; }
  .url {
    flex: 1 1 auto; min-width: 0; padding: 3px 10px; border-radius: 6px;
    background: var(--c-canvas); border: 1px solid var(--c-line); color: var(--c-fg-soft);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;
  }
  .hint { flex: none; color: var(--c-fg-dim); white-space: nowrap; }
  .loading { width: 6px; height: 6px; border-radius: 999px; background: var(--c-warn); flex: none; opacity: 0; }
  .loading.on { opacity: 1; }
  .hide {
    flex: none; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--c-line);
    background: transparent; color: var(--c-fg-soft); font: inherit; cursor: default;
    -webkit-app-region: no-drag;
  }
  .hide:hover { background: var(--c-overlay); color: var(--c-fg); }
</style>
</head>
<body>
  <span class="badge"><span class="dot"></span><span id="label">受控浏览器</span></span>
  <span class="owner" id="owner"></span>
  <span class="tabs" id="tabs"></span>
  <span class="grow">
    <span class="loading" id="loading"></span>
    <span class="url" id="url" title=""></span>
    <span class="hint" title="地址由 Mica 控制，不可手动修改">请勿手动操作</span>
  </span>
  <button class="hide" id="hide" type="button">隐藏</button>
<script>
  (function () {
    var label = document.getElementById('label')
    var owner = document.getElementById('owner')
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

    function applyPalette(palette) {
      if (!palette) return
      Object.keys(PALETTE_VARS).forEach(function (key) {
        if (palette[key]) root.style.setProperty(PALETTE_VARS[key], palette[key])
      })
    }

    document.getElementById('hide').addEventListener('click', function () { send('hide') })

    window.__micaChrome = {
      update: function (state) {
        state = state || {}
        applyPalette(state.palette)
        label.textContent = state.label || '受控浏览器'
        owner.textContent = state.owner ? '用户会话 ' + state.owner : '未归属'
        url.textContent = state.url || 'about:blank'
        url.title = state.url || ''
        loading.className = state.loading ? 'loading on' : 'loading'
        tabs.textContent = ''
        var list = state.tabs || []
        if (list.length > 1) {
          list.forEach(function (tab) {
            var node = document.createElement('span')
            node.className = tab.active ? 'tab active' : 'tab'
            var title = document.createElement('span')
            title.className = 'title'
            title.textContent = tab.title || '新标签页'
            node.appendChild(title)
            node.addEventListener('click', function () { send('activateTab', { tabId: tab.id }) })
            tabs.appendChild(node)
          })
          return
        }
        // 单标签页时标签条没有信息量，把标题放在左边就够
        if (list.length === 1) {
          var single = document.createElement('span')
          single.className = 'tab active'
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
