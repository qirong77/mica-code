/**
 * 受控浏览器窗口顶部那条 chrome（标签条 + 只读地址）。
 *
 * 它被加载进窗口自己的 webContents，**没有 preload**：状态由主进程用
 * `executeJavaScript('window.__micaChrome.update(...)')` 推进来，页面上的点击则通过
 * `console.log('__mica_chrome__' + JSON.stringify({...}))` 回到主进程（见
 * browser-manager.js 的 chrome 消息处理）—— 这样不必为了一个只读工具条给整个应用加
 * preload。所有来自主进程的数据都只用 textContent 落地，不做 innerHTML 拼接。
 *
 * 配色取应用主题（apps/desktop/src/renderer/assets/app.css 的 Darcula 令牌），改主题时
 * 这里要一起改：panel #3c3f41 / canvas #2b2b2b / line #4b4b4b / active #515658 /
 * fg #cccccc / dim #888888。
 */

export const CHROME_MESSAGE_PREFIX = '__mica_chrome__'

export function chromeHtml() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; align-items: center; gap: 8px;
    height: 38px; padding: 0 8px;
    background: #3c3f41; color: #cccccc;
    font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    border-bottom: 1px solid #4b4b4b;
    -webkit-user-select: none; user-select: none;
    -webkit-app-region: drag;
  }
  .badge {
    display: flex; align-items: center; gap: 6px; flex: none;
    padding: 2px 8px; border-radius: 999px; background: rgba(255, 255, 255, 0.06);
    color: #e2c08d; font-weight: 600; letter-spacing: 0.02em;
  }
  .dot { width: 6px; height: 6px; border-radius: 999px; background: currentColor; }
  .owner { flex: none; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #888888; }
  .tabs { display: flex; align-items: center; gap: 2px; min-width: 0; overflow: hidden; -webkit-app-region: no-drag; }
  .tab {
    display: flex; align-items: center; gap: 5px; max-width: 190px;
    padding: 3px 9px; border-radius: 6px 6px 0 0; color: #888888;
    cursor: default; white-space: nowrap; overflow: hidden;
  }
  .tab:hover { background: rgba(255, 255, 255, 0.05); color: #cccccc; }
  .tab.active { background: #2b2b2b; color: #cccccc; }
  .tab .title { overflow: hidden; text-overflow: ellipsis; }
  .grow { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; }
  .url {
    flex: 1 1 auto; min-width: 0; padding: 3px 10px; border-radius: 6px;
    background: #2b2b2b; border: 1px solid #4b4b4b; color: #a1a1a1;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left;
  }
  .hint { flex: none; color: #888888; white-space: nowrap; }
  .loading { width: 6px; height: 6px; border-radius: 999px; background: #e2c08d; flex: none; opacity: 0; }
  .loading.on { opacity: 1; }
  .hide {
    flex: none; padding: 3px 10px; border-radius: 6px; border: 1px solid #4b4b4b;
    background: transparent; color: #a1a1a1; font: inherit; cursor: default;
    -webkit-app-region: no-drag;
  }
  .hide:hover { background: rgba(255, 255, 255, 0.06); color: #cccccc; }
</style>
</head>
<body>
  <span class="badge"><span class="dot"></span><span id="label">受控浏览器</span></span>
  <span class="owner" id="owner"></span>
  <span class="tabs" id="tabs"></span>
  <span class="grow">
    <span class="loading" id="loading"></span>
    <span class="url" id="url" title=""></span>
    <span class="hint">地址由 Mica 控制，不可手动修改</span>
  </span>
  <button class="hide" id="hide" type="button">隐藏</button>
<script>
  (function () {
    var label = document.getElementById('label')
    var owner = document.getElementById('owner')
    var tabs = document.getElementById('tabs')
    var url = document.getElementById('url')
    var loading = document.getElementById('loading')

    function send(action, payload) {
      console.log('${CHROME_MESSAGE_PREFIX}' + JSON.stringify(Object.assign({ action: action }, payload || {})))
    }

    document.getElementById('hide').addEventListener('click', function () { send('hide') })

    window.__micaChrome = {
      update: function (state) {
        state = state || {}
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
