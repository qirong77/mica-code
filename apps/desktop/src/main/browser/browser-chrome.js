/**
 * 受控浏览器窗口顶部那条 chrome（后退 / 前进 / 刷新 + 可编辑地址 + 标签条）。
 *
 * 它被加载进窗口自己的 webContents，**没有 preload**：状态由主进程用
 * `executeJavaScript('window.__micaChrome.update(...)')` 推进来，页面上的操作则通过
 * `console.log('__mica_chrome__' + JSON.stringify({...}))` 回到主进程（见
 * browser-manager.js 的 chrome 消息处理）—— 这样不必为了一个工具条给整个应用加
 * preload。所有来自主进程的数据都只用 textContent / value 落地，不做 innerHTML 拼接。
 *
 * 地址框是**用户可以自己操作**的输入框：回车导航、Esc 还原、点走还原成当前页地址。
 * 用户改地址、前进后退与刷新都回主进程走与 agent 同一条 `navigate` 链路，状态照常推送。
 *
 * 配色**跟随应用主题**：外壳每次推状态都带上当前主题的调色板（`chromePalette()`），
 * 页面只需要把 `--c-*` 变量换掉。取值与 apps/desktop/src/renderer/assets/app.css 里的
 * 主题块一一对齐，改主题时两处必须一起改（`browser-chrome.test.js` 逐档比对）。
 */

export const CHROME_MESSAGE_PREFIX = '__mica_chrome__'

/**
 * 每个主题的 chrome 调色板。键与 ui-state 里的主题 id 一致，取值按下面的对应关系从
 * app.css 抄过来：panel = --color-panel、panelHi = --color-panel-hi（地址框与按钮
 * hover，对齐 Arco 的 --color-fill-2）、active = --color-active（当前标签页 /
 * 输入框 hover，对齐 --color-fill-3）、line = --color-line、lineStrong =
 * --color-line-strong（焦点环）、fg = --color-fg、fgSoft = --color-fg-soft、
 * fgDim = --color-fg-dim、fgFaint = --color-fg-faint（占位符，对齐 Arco 的
 * --color-text-3）、accent = --color-accent（输入焦点边，对齐 --primary-6）、
 * warn = --color-warn-soft（受控徽标与加载点）。
 *
 * 控件几何也照 @mica-config-ui/web 的 Arco small：Input 28px 高 / 2px 圆角 /
 * fill-2 底 / hover fill-3 / focus accent 边；icon-only Button 28×28 / 2px 圆角 /
 * hover fill-2。改样式时保持这几个数，别再回到胶囊或 6px 圆角。
 */
const PALETTES = {
  dark: {
    panel: '#3c3f41',
    panelHi: '#46484a',
    active: '#515658',
    line: '#4b4b4b',
    lineStrong: '#5a5a5a',
    fg: '#cccccc',
    fgSoft: '#a1a1a1',
    fgDim: '#888888',
    fgFaint: '#707070',
    accent: '#cc7832',
    warn: '#d7ba7d'
  },
  light: {
    panel: '#f9fafb',
    panelHi: '#f1f3f5',
    active: '#ebeef2',
    line: '#0000001a',
    lineStrong: '#00000029',
    fg: '#1b1b1c',
    fgSoft: '#43454a',
    fgDim: '#81858c',
    fgFaint: '#979da6',
    accent: '#4176e6',
    warn: '#92400e'
  },
  mocha: {
    panel: '#181825',
    panelHi: '#313244',
    active: '#313244',
    line: '#45475a',
    lineStrong: '#585b70',
    fg: '#bac2de',
    fgSoft: '#a6adc8',
    fgDim: '#7f849c',
    fgFaint: '#6c7086',
    accent: '#cba6f7',
    warn: '#fab387'
  },
  latte: {
    panel: '#e6e9ef',
    panelHi: '#dce0e8',
    active: '#ccd0da',
    line: '#bcc0cc',
    lineStrong: '#acb0be',
    fg: '#4c4f69',
    fgSoft: '#5c5f77',
    fgDim: '#7c7f93',
    fgFaint: '#8c8fa1',
    accent: '#8839ef',
    warn: '#7d5010'
  },
  'tokyo-night': {
    panel: '#16161e',
    panelHi: '#202330',
    active: '#202330',
    line: 'rgb(84 92 126 / 30%)',
    lineStrong: 'rgb(84 92 126 / 60%)',
    fg: '#a9b1d6',
    fgSoft: '#9aa5ce',
    fgDim: '#565f89',
    fgFaint: '#42465d',
    accent: '#7aa2f7',
    warn: '#ff9e64'
  },
  'tokyo-night-light': {
    panel: '#d6d8df',
    panelHi: '#c8cad4',
    active: '#c1c4cf',
    line: '#c1c2c7',
    lineStrong: '#acb0bf',
    fg: '#363c4d',
    fgSoft: '#40434f',
    fgDim: '#707280',
    fgFaint: '#888b94',
    accent: '#2959aa',
    warn: '#754d11'
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
    --c-panel: #3c3f41; --c-panel-hi: #46484a; --c-active: #515658;
    --c-line: #4b4b4b; --c-line-strong: #5a5a5a;
    --c-fg: #cccccc; --c-fg-soft: #a1a1a1; --c-fg-dim: #888888; --c-fg-faint: #707070;
    --c-accent: #cc7832; --c-warn: #d7ba7d;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; align-items: center; gap: 6px;
    height: 38px; padding: 0 8px;
    background: var(--c-panel); color: var(--c-fg);
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    border-bottom: 1px solid var(--c-line);
    -webkit-user-select: none; user-select: none;
    -webkit-app-region: drag;
  }
  /* 窗口身份（受控浏览器 / 无痕）只由窗口标题栏说一遍：这条顶栏不再重复那段文案，
     左侧只留一个状态圆点，悬停能看到归属的会话。窗口之间彼此独立（每个窗口在顶栏各有
     一枚图标），所以这条顶栏不提供「切换窗口」——那需要一个跨窗口的列表，而它只能是
     原生菜单，既跟主题脱节，也让「每个窗口独立」这件事变得没有意义。 */
  .dot { flex: none; width: 5px; height: 5px; border-radius: 999px; background: var(--c-fg-dim); }
  .dot.loading { background: var(--c-warn); }
  /* 导航按钮和地址框都不属于拖动区：它们要能点、能选、能输入 */
  .nav { flex: none; display: flex; align-items: center; gap: 2px; -webkit-app-region: no-drag; }
  /* 几何照 @mica-config-ui/web 的 Arco small：icon-only 按钮 28×28、2px 圆角、
     hover 用 fill-2（--color-panel-hi）、按下用 fill-3（--color-active）。 */
  .icon {
    display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
    border: 0; border-radius: 2px; background: transparent; color: var(--c-fg-soft); cursor: default;
  }
  .icon:hover:not(:disabled) { background: var(--c-panel-hi); color: var(--c-fg); }
  .icon:active:not(:disabled) { background: var(--c-active); }
  .icon:disabled { opacity: 0.35; }
  .icon:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--c-line-strong); }
  /* 地址框照 Arco small Input：28px 高、2px 圆角、fill-2 底、透明边框（尺寸不跳）；
     hover 换 fill-3，焦点边换 accent、底换 panel。 */
  .address {
    flex: 1 1 auto; min-width: 0; height: 28px; padding: 0 12px;
    border: 1px solid transparent; border-radius: 2px;
    background: var(--c-panel-hi); color: var(--c-fg); font: inherit; font-size: 13px; outline: none;
    -webkit-user-select: text; user-select: text; -webkit-app-region: no-drag;
  }
  .address::placeholder { color: var(--c-fg-faint); }
  .address:hover:not(:focus) { background: var(--c-active); }
  .address:focus { border-color: var(--c-accent); background: var(--c-panel); }
  .tabs { display: flex; align-items: center; gap: 3px; min-width: 0; max-width: 38%; overflow-x: auto; scrollbar-width: none; -webkit-app-region: no-drag; }
  .tabs::-webkit-scrollbar { display: none; }
  .page-title { flex: 0 1 auto; min-width: 0; max-width: 190px; padding: 0 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tab {
    display: flex; align-items: center; justify-content: center; flex: 0 0 auto; min-width: 26px; max-width: 190px;
    padding: 4px 9px; border: 0; border-radius: 2px; background: transparent; color: var(--c-fg-soft); font: inherit;
    cursor: default; white-space: nowrap; overflow: hidden;
  }
  .tab:hover { background: var(--c-panel-hi); color: var(--c-fg); }
  .tab.active { background: var(--c-active); color: var(--c-fg); }
  .tab:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--c-line-strong); }
  .tab .title { overflow: hidden; text-overflow: ellipsis; }
</style>
</head>
<body>
  <span class="dot" id="loading"></span>
  <div class="nav">
    <button type="button" class="icon" id="back" title="后退" aria-label="后退">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8H3.5"/><path d="M7.5 3.5 3 8l4.5 4.5"/></svg>
    </button>
    <button type="button" class="icon" id="forward" title="前进" aria-label="前进">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8h9.5"/><path d="M8.5 3.5 13 8l-4.5 4.5"/></svg>
    </button>
    <button type="button" class="icon" id="reload" title="刷新" aria-label="刷新">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 3.5V7h-3.5"/></svg>
    </button>
  </div>
  <input class="address" id="address" type="text" placeholder="输入域名或网址" spellcheck="false" autocomplete="off" aria-label="地址" />
  <span class="tabs" id="tabs"></span>
<script>
  (function () {
    var tabs = document.getElementById('tabs')
    var address = document.getElementById('address')
    var loading = document.getElementById('loading')
    var back = document.getElementById('back')
    var forward = document.getElementById('forward')
    var reload = document.getElementById('reload')
    var root = document.documentElement
    var PALETTE_VARS = {
      panel: '--c-panel',
      panelHi: '--c-panel-hi',
      active: '--c-active',
      line: '--c-line',
      lineStrong: '--c-line-strong',
      fg: '--c-fg',
      fgSoft: '--c-fg-soft',
      fgDim: '--c-fg-dim',
      fgFaint: '--c-fg-faint',
      accent: '--c-accent',
      warn: '--c-warn'
    }
    // 地址栏所在的标签页当前地址；用户正在输入（dirty）时状态推送不能把它覆盖掉
    var currentUrl = 'about:blank'
    var dirty = false
    var editing = false

    function send(action, payload) {
      console.log('${CHROME_MESSAGE_PREFIX}' + JSON.stringify(Object.assign({ action: action }, payload || {})))
    }

    function selectedText() {
      if (editing && typeof address.selectionStart === 'number' && address.selectionStart !== address.selectionEnd) {
        return String(address.value || '').slice(address.selectionStart, address.selectionEnd)
      }
      var selection = window.getSelection && window.getSelection()
      return selection ? String(selection) : ''
    }

    function applyPalette(palette) {
      if (!palette) return
      Object.keys(PALETTE_VARS).forEach(function (key) {
        if (palette[key]) root.style.setProperty(PALETTE_VARS[key], palette[key])
      })
    }

    function setAddress(value) {
      if (address.value === value) return
      address.value = value
    }

    // 点进地址栏就选中整条：换地址直接输入即可（再点一下可以把光标放到词中间）
    address.addEventListener('focus', function () {
      editing = true
      address.select()
    })

    address.addEventListener('input', function () {
      dirty = true
    })

    address.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        dirty = false
        setAddress(currentUrl)
        address.select()
        return
      }
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      var value = String(address.value || '').trim()
      dirty = false
      if (!value) {
        setAddress(currentUrl)
        return
      }
      send('navigate', { url: value })
    })

    // 输入到一半点走：恢复成页面当前地址（与浏览器地址栏一致）
    address.addEventListener('blur', function () {
      editing = false
      if (!dirty) return
      dirty = false
      setAddress(currentUrl)
    })

    back.addEventListener('click', function () { send('back') })
    forward.addEventListener('click', function () { send('forward') })
    reload.addEventListener('click', function () { send('reload') })

    // 复制走主进程的剪贴板：这条顶栏是 data: URL，不指望渲染进程自己的复制权限。
    document.addEventListener('keydown', function (event) {
      if (!(event.metaKey || event.ctrlKey)) return
      var key = String(event.key).toLowerCase()
      // 粘贴也交给主进程的 editing command：应用没有原生菜单，不能指望系统菜单项
      // 把 ⌘V / Ctrl+V 送进这个 data: URL 页面
      if (key === 'v' && event.target === address) {
        event.preventDefault()
        send('paste')
        return
      }
      if (key !== 'c') return
      var text = selectedText()
      if (!text) return
      event.preventDefault()
      send('copy', { text: text })
    })

    // Electron 默认不给页面右键菜单，所以右键不弹「复制」：有选中就复制选中的，没有就
    // 直接复制整条地址
    document.addEventListener('contextmenu', function (event) {
      var text = selectedText() || (event.target === address ? String(address.value || '') : '')
      if (!text) return
      event.preventDefault()
      send('copy', { text: text })
    })

    window.__micaChrome = {
      update: function (state) {
        state = state || {}
        applyPalette(state.palette)
        var who = (state.incognito ? '无痕 · ' : '') + (state.label || '受控浏览器')
        loading.title = who + (state.owner ? '\\n用户会话 ' + state.owner : '\\n未归属')
        loading.className = state.loading ? 'dot loading' : 'dot'
        currentUrl = state.url || 'about:blank'
        if (!dirty) setAddress(currentUrl)
        address.title = currentUrl + '\\n输入网址后回车导航，Esc 取消'
        back.disabled = !state.canGoBack
        forward.disabled = !state.canGoForward
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
        // 单标签页时标签条没有信息量，把标题放在右边就够
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
