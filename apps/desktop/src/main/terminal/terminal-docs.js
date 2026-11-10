/**
 * 终端控制的端点目录与文档。**唯一事实来源**：服务路由由它编译，`/terminal/capabilities`、
 * `/terminal/docs`、设置页与 MCP server 暴露给 agent 的操作清单都从它生成，
 * 不会出现「文档写了但路由没实现」的漂移。
 */

import { withPathParams } from '../shared/endpoint-params.js'

const ownerParam = {
  name: 'x-mica-owner',
  in: 'header',
  required: false,
  description:
    '归属的会话（Mica 会话 id 或工作区页签 id）。agent 里用 $MICA_TERMINAL_OWNER，写进这个头，终端窗口就会挂到该会话下。新建终端必须带它。'
}

const RAW_ENDPOINTS = [
  {
    id: 'health',
    method: 'GET',
    path: '/health',
    summary: '服务探活',
    params: [],
    returns: '{ ok, app, version }'
  },
  {
    id: 'capabilities',
    method: 'GET',
    path: '/capabilities',
    summary: '能力与端点目录（机器可读，与路由同源）',
    params: [],
    returns: '{ ok, app, version, endpoints: [{ id, method, path, summary }] }'
  },
  {
    id: 'docs',
    method: 'GET',
    path: '/docs',
    summary: '完整文档与给 agent 的短提示',
    params: [],
    returns: '{ ok, endpoints, markdown, guide }'
  },
  {
    id: 'listSessions',
    method: 'GET',
    path: '/sessions',
    summary: '列出所有终端会话（含归属、cwd、屏幕尺寸与运行状态）',
    params: [
      { name: 'owner', in: 'query', required: false, description: '只看这个会话创建的终端' }
    ],
    returns: '{ ok, sessions: [TerminalSession] }'
  },
  {
    id: 'createSession',
    method: 'POST',
    path: '/sessions',
    summary: '开一个真实终端，返回会话 id（必须带归属；窗口按需打开，默认不创建）',
    params: [
      { name: 'cwd', in: 'body', required: false, description: '工作目录，默认用户主目录' },
      {
        name: 'shell',
        in: 'body',
        required: false,
        description: '登录 shell 路径，默认系统 shell'
      },
      { name: 'cols', in: 'body', required: false, description: '列数，默认 120' },
      { name: 'rows', in: 'body', required: false, description: '行数，默认 32' },
      { name: 'label', in: 'body', required: false, description: '窗口标签，界面上区分多个终端' },
      {
        name: 'show',
        in: 'body',
        required: false,
        description: 'true 时立刻打开窗口并显示；省略则只跑 PTY，不创建窗口'
      },
      ownerParam
    ],
    returns: '{ ok, session }',
    example:
      'curl -s -X POST "$MICA_TERMINAL_URL/sessions" -H \'content-type: application/json\' \\\n  -H "x-mica-owner: $MICA_TERMINAL_OWNER" \\\n  -d \'{"cwd":"/tmp","label":"dev server"}\''
  },
  {
    id: 'getSession',
    method: 'GET',
    path: '/sessions/:id',
    summary: '会话详情 + 当前屏幕文本（真实视觉行，保留软换行与光标坐标，不是原始转义流）',
    params: [
      {
        name: 'maxLines',
        in: 'query',
        required: false,
        description: '最多返回多少行屏幕，默认 200（含滚动历史）'
      }
    ],
    returns: '{ ok, session }（session.screen.text / lines / cursor / inputLine）'
  },
  {
    id: 'readOutput',
    method: 'GET',
    path: '/sessions/:id/output',
    summary: '按字节序号读原始输出（ANSI 保留，断线续传用 since）',
    params: [
      {
        name: 'since',
        in: 'query',
        required: false,
        description: '从该字符序号开始；省略为从头'
      }
    ],
    returns: '{ ok, seq, data, truncated }'
  },
  {
    id: 'writeInput',
    method: 'POST',
    path: '/sessions/:id/input',
    summary: '往终端输入：data 原样写入；或 text + submit（自动补回车）',
    params: [
      { name: 'data', in: 'body', required: false, description: '原始输入（可含转义序列）' },
      { name: 'text', in: 'body', required: false, description: '按文本输入（可多行）' },
      {
        name: 'submit',
        in: 'body',
        required: false,
        description: 'text 之后补一个回车（true）'
      }
    ],
    returns: '{ ok, seq }',
    example:
      'curl -s -X POST "$MICA_TERMINAL_URL/sessions/$TERM/input" \\\n  -H \'content-type: application/json\' -d \'{"text":"git status","submit":true}\''
  },
  {
    id: 'keys',
    method: 'POST',
    path: '/sessions/:id/keys',
    summary: '按命名键：Enter / Tab / Escape / 方向键 / Ctrl+C / 单字符',
    params: [
      {
        name: 'keys',
        in: 'body',
        required: true,
        description: '数组，如 ["ctrl+c"]、["down","Enter"]、["y"]'
      }
    ],
    returns: '{ ok, seq }'
  },
  {
    id: 'resize',
    method: 'POST',
    path: '/sessions/:id/resize',
    summary: '调整终端尺寸（pty 与屏幕镜像一起改，AI 与页面看到同一尺寸）',
    params: [
      { name: 'cols', in: 'body', required: true, description: '列数（20–400）' },
      { name: 'rows', in: 'body', required: true, description: '行数（5–200）' }
    ],
    returns: '{ ok, session }'
  },
  {
    id: 'waitFor',
    method: 'POST',
    path: '/sessions/:id/wait',
    summary:
      '等待终端条件：文本出现 / 正则匹配 / 输出静默（idleMs）/ 进程退出 / 指定退出码；返回时机与是否命中',
    params: [
      {
        name: 'text',
        in: 'body',
        required: false,
        description: '逻辑文本包含该片段：只拼接 xterm 软换行，保留真实换行；默认跳过命令回显逻辑行'
      },
      {
        name: 'regex',
        in: 'body',
        required: false,
        description: '匹配同一份软换行逻辑文本；真实换行仍为 \\n，返回 screen 保留视觉行'
      },
      {
        name: 'idleMs',
        in: 'body',
        required: false,
        description: '连续无输出达到该毫秒数；不代表命令结束或成功'
      },
      {
        name: 'exited',
        in: 'body',
        required: false,
        description: 'true 时等待 PTY/shell 进程退出，不是 shell 内某条命令结束'
      },
      {
        name: 'expectExitCode',
        in: 'body',
        required: false,
        description: '等待 PTY/shell 进程退出且退出码等于该值；不是 shell 内任意命令的退出码'
      },
      {
        name: 'skipEcho',
        in: 'body',
        required: false,
        description:
          '默认 true：仅在匹配 text/regex 前遮罩刚输入命令的回显逻辑行；false 可匹配回显，返回 screen 始终不变'
      },
      { name: 'timeoutMs', in: 'body', required: false, description: '默认 15000' }
    ],
    returns:
      '{ ok, matched, reason, exitCode?, signal?, elapsedMs, screen }；screen 始终为原始视觉行与坐标，不附加逻辑文本；reason 取值 text / regex / idle / exited / exitCode / timeout / closed；expectExitCode 不匹配时立刻返回 matched:false 并带上实际 exitCode'
  },
  {
    id: 'showSession',
    method: 'POST',
    path: '/sessions/:id/show',
    summary: '把终端窗口显示到前台（用户点顶栏图标等价于此）',
    params: [],
    returns: '{ ok, session }'
  },
  {
    id: 'hideSession',
    method: 'POST',
    path: '/sessions/:id/hide',
    summary: '隐藏窗口但保留 PTY 与滚动内容（用户点关闭也走这里）',
    params: [],
    returns: '{ ok, session }'
  },
  {
    id: 'closeSession',
    method: 'POST',
    path: '/sessions/:id/close',
    summary: '结束进程并销毁窗口（不可恢复）',
    params: [],
    returns: '{ ok }'
  },
  {
    id: 'events',
    method: 'SSE',
    path: '/events',
    summary: '会话输出与状态推送（窗口页面用它渲染；可按 session 过滤、按 since 续传）',
    params: [
      { name: 'session', in: 'query', required: false, description: '只订阅这个会话' },
      { name: 'since', in: 'query', required: false, description: '从该字符序号开始补发' }
    ],
    returns: 'text/event-stream：{ channel: "terminal:output"|"terminal:changed", payload }'
  }
]

/** 路径参数（`:id`）由 `withPathParams` 补齐，MCP 门面才能把会话 id 填进 path。 */
export const TERMINAL_ENDPOINTS = withPathParams(RAW_ENDPOINTS, () => '终端会话 id')

const byId = new Map(TERMINAL_ENDPOINTS.map((endpoint) => [endpoint.id, endpoint]))

export function endpointById(id) {
  return byId.get(id) || null
}

export function capabilityCatalog() {
  return TERMINAL_ENDPOINTS.map((endpoint) => ({
    id: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
    summary: endpoint.summary
  }))
}

function paramLabel(param) {
  return `${param.name}（${param.in}${param.required ? '，必填' : ''}）`
}

/**
 * 给 agent 的短提示：MCP tool 返回的 doc 列表里带这段，比让模型翻整份 markdown 更省上下文。
 * 详细文档仍然由 `buildDocsMarkdown` 生成（`/docs` 与设置页用）。
 */
export const TERMINAL_GUIDE = [
  '推荐流程：createSession → waitFor({idleMs:800}) 后 getSession 确认登录 shell 已出提示符 → writeInput → waitFor 等明确输出或完成标记 → getSession 读屏幕。',
  '屏幕文本已经过 ANSI 解析，TUI 的重绘、清屏、光标位置都按终端语义落定，不需要自己剥转义。',
  'waitFor 的 text/regex 按软换行逻辑文本匹配：仅按 xterm isWrapped 拼接软换行，真实换行保留为 \\n；默认遮罩刚输入命令的回显逻辑行（30 秒内写入的原文），确实要匹配回显时传 skipEcho:false。getSession 与 waitFor 返回的 screen 始终保留真实视觉行、原始回显及光标坐标，不另返回逻辑文本。',
  'expectExitCode 等待的是 PTY/shell 进程退出，不是 shell 内任意命令的退出码；命令成败须取该命令的实际退出码。持久 POSIX shell 的非破坏示例：输入 `pwd; mica_rc=$?; printf "\\nMICA_RC_%s_END\\n" "$mica_rc"`，waitFor({regex:"MICA_RC_[0-9]+_END"}) 后从输出读取数字，0 才是成功；每次使用唯一标记避免命中旧输出，且不要混用 idleMs（任一条件命中即可返回）。',
  '仅在专用、允许结束的 POSIX shell 终端里，可输入 `pwd; mica_rc=$?; exit "$mica_rc"` 再 waitFor({expectExitCode:0})；exit 会结束终端，不要在共享或仍需使用的终端里这样做。',
  '进程退出后屏幕仍可读；用完请自己 closeSession。没有归属的终端会被立刻回收；没有窗口在看的已退出会话空闲 10 分钟后回收，活会话默认空闲 30 分钟后回收（MICA_TERMINAL_IDLE_REAP_MS 可调，0 关闭活会话自动回收）。输出、输入、读屏、等待与改尺寸会续期，在途请求不回收；回收会关闭 PTY 并释放屏幕缓存和窗口，再用需要新建终端。',
  'idleMs 只代表「这段时间没有新输出」，不代表命令结束或成功，失败、等待输入与静默运行都可能 idle；刚创建的终端也可能还在启动 shell，应先读屏确认就绪。'
].join('\n')

export function buildDocsMarkdown({ serviceUrl = '$MICA_TERMINAL_URL' } = {}) {
  const lines = [
    '# 终端控制（Mica 桌面端内置）',
    '',
    '这是 Mica 桌面应用自己托管的**真实终端**：node-pty 打开真实 pty 设备与登录 shell，',
    '和 Terminal.app / VS Code 的底层相同。终端跑在一个后台窗口里（默认隐藏），AI 通过',
    '下面的 HTTP 接口读屏幕、输入命令、按 Ctrl+C、等待输出。',
    '',
    `服务地址：\`${serviceUrl}\``,
    '',
    '请求头带 `x-mica-owner: $MICA_TERMINAL_OWNER` 会把新终端归属到当前会话，**新建终端必须带它**（缺了返回 400，没有归属的终端会被回收——顶栏只显示本会话自己的终端）；带上之后，',
    '输入、按键、resize、关闭都只对这个会话自己的终端生效（别人的终端返回 403），列表与',
    '读屏不受限制。窗口按需打开：不传 `show` 就不会创建渲染进程，需要人看时再 POST .../show。',
    '',
    '端点路径都相对服务地址：`$MICA_TERMINAL_URL/sessions` 就是 `POST /remote/terminal/sessions`。',
    '',
    ...TERMINAL_GUIDE.split('\n'),
    '',
    '## 端点',
    ''
  ]
  for (const endpoint of TERMINAL_ENDPOINTS) {
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
