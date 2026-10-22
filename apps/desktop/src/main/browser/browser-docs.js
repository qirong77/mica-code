/**
 * 受控浏览器的端点目录与文档。**这是唯一事实来源**：主进程的 HTTP 路由表由它编译
 * （见 browser-core.js 的 compileRoutes），设置页的 Browser Control 一节和写进
 * `$MICA_HOME/skills/mica-browser/SKILL.md` 的技能文档也由它生成 —— 于是不会出现
 * 「文档写了但路由没实现」或反过来的漂移。
 */

export const BROWSER_SERVICE_APP = 'mica-code-browser'
export const BROWSER_SERVICE_VERSION = 1

const ownerParam = {
  name: 'x-mica-owner',
  in: 'header',
  required: false,
  description:
    '归属的会话（Mica 会话 id 或工作区页签 id）。agent 里用 $MICA_BROWSER_OWNER，写进这个头，窗口就会挂到该会话的图标行上。'
}

export const BROWSER_ENDPOINTS = [
  {
    id: 'health',
    method: 'GET',
    path: '/browser/health',
    summary: '服务探活',
    params: [],
    returns: '{ ok, app, version }'
  },
  {
    id: 'capabilities',
    method: 'GET',
    path: '/browser/capabilities',
    summary: '能力与端点目录（机器可读，改路由时同源）',
    params: [],
    returns: '{ ok, app, version, endpoints: [{ id, method, path, summary }] }'
  },
  {
    id: 'docs',
    method: 'GET',
    path: '/browser/docs',
    summary: '完整文档与技能文件原文',
    params: [],
    returns: '{ ok, endpoints, markdown, skillMarkdown }'
  },
  {
    id: 'listBrowsers',
    method: 'GET',
    path: '/browser/browsers',
    summary: '列出所有受控浏览器窗口（含标签页摘要）',
    params: [],
    returns: '{ ok, browsers: [Browser] }',
    example: 'curl -s "$MICA_BROWSER_URL/browser/browsers"'
  },
  {
    id: 'createBrowser',
    method: 'POST',
    path: '/browser/browsers',
    summary: '新开一个受控浏览器窗口（默认不打断用户，先隐藏着建）',
    params: [
      { name: 'url', in: 'body', required: false, description: '初始地址，省略则开 about:blank' },
      { name: 'owner', in: 'body', required: false, description: '归属会话 id' },
      {
        name: 'label',
        in: 'body',
        required: false,
        description: '窗口标签，界面上用它区分多个窗口'
      },
      { name: 'show', in: 'body', required: false, description: 'true 时立刻显示到前台' },
      ownerParam
    ],
    returns: '{ ok, browser }',
    example:
      'curl -s -X POST "$MICA_BROWSER_URL/browser/browsers" -H \'content-type: application/json\' \\\n  -H "x-mica-owner: $MICA_BROWSER_OWNER" \\\n  -d \'{"url":"https://example.com","label":"登录页"}\''
  },
  {
    id: 'getBrowser',
    method: 'GET',
    path: '/browser/browsers/:id',
    summary: '单个窗口的详情',
    params: [],
    returns: '{ ok, browser }'
  },
  {
    id: 'showBrowser',
    method: 'POST',
    path: '/browser/browsers/:id/show',
    summary: '显示到前台（用户点顶栏图标等价于此）',
    params: [],
    returns: '{ ok, browser }'
  },
  {
    id: 'hideBrowser',
    method: 'POST',
    path: '/browser/browsers/:id/hide',
    summary: '隐藏窗口但保留页面状态（等价于用户点关闭：只隐藏，不销毁）',
    params: [],
    returns: '{ ok, browser }'
  },
  {
    id: 'closeBrowser',
    method: 'POST',
    path: '/browser/browsers/:id/close',
    summary: '真正销毁窗口（连同它的标签页与页面状态）',
    params: [],
    returns: '{ ok }'
  },
  {
    id: 'listTabs',
    method: 'GET',
    path: '/browser/tabs',
    summary: '列出所有标签页（可只取某个归属的）',
    params: [{ name: 'owner', in: 'query', required: false, description: '只看这个会话的窗口' }],
    returns: '{ ok, tabs: [Tab] }'
  },
  {
    id: 'createTab',
    method: 'POST',
    path: '/browser/tabs',
    summary: '在已有窗口里新开标签页（不给 browserId 就新开一个窗口）',
    params: [
      { name: 'browserId', in: 'body', required: false, description: '目标窗口' },
      { name: 'url', in: 'body', required: false, description: '初始地址' }
    ],
    returns: '{ ok, tab, browser }'
  },
  {
    id: 'activateTab',
    method: 'POST',
    path: '/browser/tabs/:id/activate',
    summary: '切换窗口内的当前标签页',
    params: [],
    returns: '{ ok, browser }'
  },
  {
    id: 'closeTab',
    method: 'POST',
    path: '/browser/tabs/:id/close',
    summary: '关闭标签页（窗口里最后一个标签页被关掉时窗口一起销毁）',
    params: [],
    returns: '{ ok, browser? }'
  },
  {
    id: 'navigate',
    method: 'POST',
    path: '/browser/tabs/:id/navigate',
    summary: '导航：给 url 就去那儿，给 action 就前进/后退/刷新',
    params: [
      {
        name: 'url',
        in: 'body',
        required: false,
        description: '目标地址（没有协议时按 https 补全）'
      },
      {
        name: 'action',
        in: 'body',
        required: false,
        description: 'back / forward / reload（与 url 二选一）'
      }
    ],
    returns: '{ ok, tab }',
    example:
      'curl -s -X POST "$MICA_BROWSER_URL/browser/tabs/$TAB/navigate" -H \'content-type: application/json\' \\\n  -d \'{"url":"github.com"}\''
  },
  {
    id: 'evaluate',
    method: 'POST',
    path: '/browser/tabs/:id/evaluate',
    summary: '在页面主世界执行 JS 并取回结果（读 DOM、取 localStorage 都走它）',
    params: [
      { name: 'expression', in: 'body', required: true, description: '要执行的表达式，支持 await' },
      { name: 'timeoutMs', in: 'body', required: false, description: '默认 15000' }
    ],
    returns: '{ ok, value }'
  },
  {
    id: 'content',
    method: 'GET',
    path: '/browser/tabs/:id/content',
    summary: '取页面文本（默认 innerText，可要 html）—— 「看看这一页写了什么」',
    params: [
      { name: 'format', in: 'query', required: false, description: 'text（默认）/ html' },
      {
        name: 'maxChars',
        in: 'query',
        required: false,
        description: '默认 200000，超出会截断并标记'
      }
    ],
    returns: '{ ok, url, title, format, content, truncated }'
  },
  {
    id: 'click',
    method: 'POST',
    path: '/browser/tabs/:id/click',
    summary:
      '点击：给 selector 按元素中心点，或直接给坐标（窗口隐藏时临时显示出来按原生输入点，点完恢复隐藏）',
    params: [
      { name: 'selector', in: 'body', required: false, description: 'CSS 选择器（与坐标二选一）' },
      { name: 'x', in: 'body', required: false, description: '视口坐标' },
      { name: 'y', in: 'body', required: false, description: '视口坐标' }
    ],
    returns: '{ ok, target, via }（via=native 原生输入 / in-page 页面内合成）'
  },
  {
    id: 'type',
    method: 'POST',
    path: '/browser/tabs/:id/type',
    summary:
      '输入文本：可先聚焦 selector，可清空，可回车提交；窗口隐藏时临时显示出来走原生输入，输完恢复隐藏',
    params: [
      { name: 'selector', in: 'body', required: false, description: '先聚焦的元素' },
      { name: 'text', in: 'body', required: true, description: '要输入的内容' },
      { name: 'clear', in: 'body', required: false, description: '先清空该元素的值' },
      { name: 'submit', in: 'body', required: false, description: '输入后按 Enter' }
    ],
    returns: '{ ok, via, value, submitted }'
  },
  {
    id: 'keys',
    method: 'POST',
    path: '/browser/tabs/:id/keys',
    summary: '按键：Enter / Tab / Escape / 方向键 / 单字符',
    params: [{ name: 'keys', in: 'body', required: true, description: '数组，如 ["Enter"]' }],
    returns: '{ ok }'
  },
  {
    id: 'scroll',
    method: 'POST',
    path: '/browser/tabs/:id/scroll',
    summary: '滚动页面（按像素，正数向下）',
    params: [{ name: 'deltaY', in: 'body', required: true, description: '像素，可为负' }],
    returns: '{ ok, scrollY }'
  },
  {
    id: 'screenshot',
    method: 'GET',
    path: '/browser/tabs/:id/screenshot',
    // 隐藏窗口没有显示面：截图期间会临时把窗口显示出来（透明度 0，用户看不到），截完收起
    summary: '截图（窗口隐藏时会临时显示出来再截，截完恢复隐藏；整页截图传 fullPage=true）',
    params: [
      { name: 'fullPage', in: 'query', required: false, description: 'true 时截整页' },
      {
        name: 'raw',
        in: 'query',
        required: false,
        description: 'true 时直接返回 image/png 字节，否则返回 dataUrl'
      },
      {
        name: 'timeoutMs',
        in: 'query',
        required: false,
        description: '默认 20000；页面忙时超时返回错误而不是一直挂着'
      }
    ],
    returns: '{ ok, dataUrl, bytes }'
  },
  {
    id: 'waitFor',
    method: 'POST',
    path: '/browser/tabs/:id/wait',
    summary:
      '等待条件成立：元素出现 / 文本出现 / 地址匹配；三个条件都不给时等页面加载完成（document.readyState=complete）',
    params: [
      {
        name: 'selector',
        in: 'body',
        required: false,
        description: '等待元素出现（与 text / url / 空条件四选一）'
      },
      { name: 'text', in: 'body', required: false, description: '等待正文包含该文本' },
      { name: 'url', in: 'body', required: false, description: '等待地址包含该片段' },
      { name: 'timeoutMs', in: 'body', required: false, description: '默认 10000' }
    ],
    returns: '{ ok, matched, elapsedMs }'
  },
  {
    id: 'cookies',
    method: 'GET',
    path: '/browser/tabs/:id/cookies',
    summary: '读 cookie（含 HttpOnly；format=header 直接给可用的 Cookie 头）',
    params: [
      { name: 'format', in: 'query', required: false, description: 'json（默认）/ header' },
      {
        name: 'url',
        in: 'query',
        required: false,
        description: '改用它作为作用域，默认取当前页地址'
      }
    ],
    returns: '{ ok, url, count, cookieHeader, cookies }',
    example: 'curl -s "$MICA_BROWSER_URL/browser/tabs/$TAB/cookies?format=header"'
  },
  {
    id: 'cookiesForScope',
    method: 'GET',
    path: '/browser/cookies',
    summary: '按 url 直接读 cookie（不需要标签页），并把结果缓存成固定文件供别的进程复用',
    params: [
      {
        name: 'url',
        in: 'query',
        required: true,
        description: '作用域地址，例如 https://osim108.zuche-saas.osim.intra.xiaojukeji.com/'
      },
      { name: 'format', in: 'query', required: false, description: 'json（默认）/ header' },
      {
        name: 'save',
        in: 'query',
        required: false,
        description:
          '1（默认）时把 Cookie 头与明细写到应用 userData 下的 browser-cookies/（macOS: ~/Library/Application Support/mica-code-app/browser-cookies/），0 时只读不写'
      }
    ],
    returns: '{ ok, url, count, cookieHeader, cookies, saved: { headerPath, jsonPath } }',
    example:
      'curl -s "$MICA_BROWSER_URL/browser/cookies?format=header&url=https%3A%2F%2Fexample.com%2F"'
  },
  {
    id: 'console',
    method: 'GET',
    path: '/browser/tabs/:id/console',
    summary: '页面控制台消息（从标签页创建起累计，clear=1 读完清空）',
    params: [{ name: 'clear', in: 'query', required: false, description: '1 时清空' }],
    returns: '{ ok, entries: [{ level, message, source, line, at }] }'
  },
  {
    id: 'network',
    method: 'GET',
    path: '/browser/tabs/:id/network',
    summary:
      '网络请求记录（CDP 采集，含 4xx/5xx、请求头 headers、请求体 body、状态码），clear=1 读完清空',
    params: [{ name: 'clear', in: 'query', required: false, description: '1 时清空' }],
    returns:
      '{ ok, entries: [{ method, url, status, resourceType, headers, body, at }] }（headers 是所有非敏感请求头，可用来确认 `nuwa-wings` 这类环境头；body 是 POST 请求体，两者超长都会截断）'
  },
  {
    id: 'events',
    method: 'SSE',
    path: '/browser/events',
    summary: '窗口/标签页变化推送（桌面端运行时订阅它，再广播给页面）',
    params: [],
    returns: 'text/event-stream：{ channel: "browser:changed", payload: { browsers } }'
  }
]

const byId = new Map(BROWSER_ENDPOINTS.map((endpoint) => [endpoint.id, endpoint]))

export function endpointById(id) {
  return byId.get(id) || null
}

export function capabilityCatalog() {
  return BROWSER_ENDPOINTS.map((endpoint) => ({
    id: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
    summary: endpoint.summary
  }))
}

function paramLabel(param) {
  return `${param.name}（${param.in}${param.required ? '，必填' : ''}）`
}

export function buildDocsMarkdown({ serviceUrl = '$MICA_BROWSER_URL' } = {}) {
  const lines = [
    '# 受控浏览器（Mica 桌面端内置）',
    '',
    '这是 Mica 桌面应用自己托管的浏览器：窗口由 Mica 创建、由 AI 通过 HTTP 驱动，',
    '地址栏不可编辑，用户关窗口只是隐藏（页面状态保留）。',
    '',
    `服务地址：\`${serviceUrl}\``,
    '',
    '请求头带 `x-mica-owner: $MICA_BROWSER_OWNER` 会把新建窗口归属到当前会话（不带则显示为「未归属」）。',
    '',
    '## 使用提示（踩过的坑）',
    '',
    '- 先 `GET /browser/health` 探活。返回 503 且 error 提到 socket 不存在/未响应，说明 Mica Code',
    '  应用（主进程）没在提供这个服务，重启应用可恢复；纯 `npm run start:web` 的宿主没有这个能力。',
    '- 复杂脚本不要塞进 shell 的 `curl -d`：把 `{"expression":"…"}` 写成 JSON 文件，再 `curl -d @文件`。',
    '  在命令里手写转义是最常见的失败来源（引号、反斜杠、换行各错一次就白跑一轮）。',
    '  页面逻辑建议放 `(async () => { … })()`，`evaluate` 会等待 Promise。',
    '- 等页面别 `sleep`：用 `POST /browser/tabs/:id/wait`（不给条件 = 等加载完成，也可等元素/文本/地址）。',
    '- 要核对请求参数就看 `GET /browser/tabs/:id/network` 的 `body`，不要在页面里 hook `fetch`/`XMLHttpRequest`',
    '  —— hook 会干扰真实请求，已经出现过把页面请求打坏、必须回滚的情况。',
    '- 想确认「请求到底打给哪个后端 / 环境头有没有带上」，看同一条记录的 `headers`（如 `nuwa-wings`），',
    '  不用自己再发一遍请求做对照实验。',
    '- 截图超时（页面忙、长任务）先重试；仍失败就改用 `evaluate` 读 DOM / `content` 校验收敛。',
    '',
    '## 端点',
    ''
  ]
  for (const endpoint of BROWSER_ENDPOINTS) {
    lines.push(`### ${endpoint.method} ${endpoint.path}`)
    lines.push('')
    lines.push(endpoint.summary)
    if (endpoint.params?.length) {
      lines.push('')
      for (const param of endpoint.params)
        lines.push(`- ${paramLabel(param)}：${param.description}`)
    }
    if (endpoint.returns) {
      lines.push('')
      lines.push(`返回：\`${endpoint.returns}\``)
    }
    if (endpoint.example) {
      lines.push('')
      lines.push('```bash')
      lines.push(endpoint.example)
      lines.push('```')
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * 写进 `$MICA_HOME/skills/mica-browser/SKILL.md` 的技能。
 *
 * 刻意只有一行地址：接口清单会随服务演进，抄一份到技能里就会两处分叉（用户目录里那份
 * 还会被下次启动覆盖）。agent 拿到地址后 GET `${url}/browser/docs` 自己取最新文档。
 */
export function buildSkillMarkdown() {
  return `---
name: mica-browser
---

$MICA_BROWSER_URL
`
}
