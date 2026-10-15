/**
 * 受控浏览器的端点目录与文档。**这是唯一事实来源**：主进程的 HTTP 路由表由它编译
 * （见 browser-core.js 的 compileRoutes），设置页的 Browser Control 一节和写进
 * `$MICA_HOME/skills/mica-browser/SKILL.md` 的技能文档也由它生成 —— 于是不会出现
 * 「文档写了但路由没实现」或反过来的漂移。
 */

import { BROWSER_PARTITION } from './browser-core.js'

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
    summary: '点击：给 selector 按元素中心点，或直接给坐标（隐藏窗口自动退化成页面内合成事件）',
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
      '输入文本：可先聚焦 selector，可清空，可回车提交；隐藏窗口用页面内合成事件（受控组件也认）',
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
    summary: '截图（窗口隐藏着也拿得到；整页截图传 fullPage=true）',
    params: [
      { name: 'fullPage', in: 'query', required: false, description: 'true 时截整页' },
      {
        name: 'raw',
        in: 'query',
        required: false,
        description: 'true 时直接返回 image/png 字节，否则返回 dataUrl'
      }
    ],
    returns: '{ ok, dataUrl, bytes }'
  },
  {
    id: 'waitFor',
    method: 'POST',
    path: '/browser/tabs/:id/wait',
    summary: '等待条件成立：元素出现 / 文本出现 / 地址匹配',
    params: [
      { name: 'selector', in: 'body', required: false, description: '等待元素出现' },
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
    summary: '网络请求记录（CDP 采集，含 4xx/5xx），clear=1 读完清空',
    params: [{ name: 'clear', in: 'query', required: false, description: '1 时清空' }],
    returns: '{ ok, entries: [{ method, url, status, resourceType, at }] }'
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
 * 写进 `$MICA_HOME/skills/mica-browser/SKILL.md` 的技能：agent 靠它知道「这台机器上有一套
 * 能真正打开的浏览器」，以及怎么把窗口挂到当前会话上。
 */
export function buildSkillMarkdown() {
  const rows = BROWSER_ENDPOINTS.map(
    (endpoint) => `| \`${endpoint.method} ${endpoint.path}\` | ${endpoint.summary} |`
  )
  return `---
name: mica-browser
description: 驱动 Mica 桌面端内置的受控浏览器（真实 Chromium 窗口）。当任务需要打开网页、登录后抓取内容、点击/输入、截图、读 cookie（含 HttpOnly）、观察控制台与网络请求时使用。
---

# 受控浏览器

Mica 桌面应用内置了一批**真实 Chromium 窗口**，由本机的一个 HTTP 服务控制，供 agent 驱动。
它和你自己起 Chromium/Playwright 的区别是：窗口就活在用户的 Mica 里，用户能在顶栏看到它、
点开它、也能自己操作，所以**需要人看见或接手的浏览都该用它**。

## 接入

- 服务地址：\`$MICA_BROWSER_URL\`（由 Mica 注入到本进程环境变量，没设置说明当前不在桌面端里运行，不要用）
- 归属：请求头 \`x-mica-owner: $MICA_BROWSER_OWNER\`。带上它，窗口会挂到当前会话的图标行上，
  用户一眼知道是谁开的；不带也能用，只是显示成「未归属」。
- 认证：无。服务只监听 127.0.0.1，非 GET 请求要求 JSON 请求体。
- 浏览器数据走独立的持久分区（\`${BROWSER_PARTITION}\`），与 Mica 应用本身互不干扰，登录状态跨重启保留。

## 固定流程

1. 开窗口（可顺手设 label，用户靠它区分多个窗口）：
   \`curl -s -X POST "$MICA_BROWSER_URL/browser/browsers" -H 'content-type: application/json' -H "x-mica-owner: $MICA_BROWSER_OWNER" -d '{"url":"https://example.com","label":"订单页"}'\`
2. 拿到 \`browser.tabs[0].id\`（下称 \`$TAB\`），之后所有页面操作都用它。
3. 读内容：\`curl -s "$MICA_BROWSER_URL/browser/tabs/$TAB/content"\`（大页面用 \`maxChars\` 收窄）
4. 需要交互就 \`click\` / \`type\` / \`keys\` / \`scroll\`，等条件成立用 \`wait\`，别用 sleep 硬等。
5. 需要视觉确认时 \`screenshot\`（窗口隐藏着也能截），需要喂给别的工具就用返回的 dataUrl。
6. 用完 \`POST /browser/tabs/$TAB/close\`，或整个 \`POST /browser/browsers/$ID/close\`。
   只是暂时不看它就用 \`hide\`，页面状态会保留。

## 端点一览

| 端点 | 说明 |
| --- | --- |
${rows.join('\n')}

## 要注意的

- 窗口**默认隐藏着建**（不打断用户），用户点顶栏图标或你调 \`show\` 才会显示。别频繁 show。
- 用户点窗口的关闭按钮等于 \`hide\`，不是销毁 —— 下次 \`show\` 页面还在原来那一步。
- \`content\` 给的是渲染后的 innerText，动态页面请先 \`wait\` 再读。
- cookie 用 \`?format=header\` 直接拿可发送的 Cookie 头；HttpOnly 也在里面。
  这些是真实凭据，别写进日志、别提交到仓库、别发到外部服务。
- 地址栏不可编辑是设计：导航由你和页面内的链接决定，不要试图让用户手输地址。
`
}
