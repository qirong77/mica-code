export type ConfigWebSection =
  | 'config'
  | 'sessions'
  | 'roles'
  | 'mcp'
  | 'skills'
  | 'capabilities'
  | 'plugins'
  | 'browserControl'
  | 'terminalControl'
  | 'performance';

/**
 * 一条性能/日志记录。字段按需存在：`event` + `scope` 一定有，
 * 其余（ms、lag、long、error…）取决于这条记录来自哪个探针。
 */
export type ConfigWebPerfEvent = {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  event: string;
  ms?: number;
  lag?: number;
  long?: number;
  longN?: number;
  dom?: number;
  rows?: number;
  heapMB?: number;
  vis?: number;
  count?: number;
  error?: string;
};

/** 按「功能点（scope:event）」聚合的耗时统计，用来回答「哪个功能慢」。 */
export type ConfigWebPerfBucket = {
  scope: string;
  event: string;
  count: number;
  slow: number;
  fails: number;
  avgMs: number;
  maxMs: number;
};

/** 渲染层每秒一个采样点，按时间聚合后的视图。 */
export type ConfigWebPerfTimelinePoint = {
  at: number;
  lag: number;
  long: number;
  longN: number;
  dom: number;
  heapMB?: number;
};

export type ConfigWebPerformanceDetails = {
  available: boolean;
  /** 日志目录（系统 temp，开机自动清空）。 */
  dir: string;
  files: Array<{ name: string; bytes: number; modifiedAt: number }>;
  totals: {
    events: number;
    errors: number;
    warns: number;
    slowCalls: number;
    /** 采样点数与观测时长。 */
    samples: number;
    /** 隐藏窗口的采样数：这类采样没有 lag（定时器被节流），不计入 samples。 */
    hiddenSamples: number;
    spanMs: number;
  };
  /** 当前进程内还没落盘的条数。 */
  pending: number;
  buckets: ConfigWebPerfBucket[];
  timeline: ConfigWebPerfTimelinePoint[];
  events: ConfigWebPerfEvent[];
};

export type ConfigWebFilePayload = {
  path: string;
  content: string;
};

export type ConfigWebServerInfo = {
  url: string;
  port: number;
  reused: boolean;
};

export type ConfigWebConversationItemType =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'reasoning'
  | 'unknown';

export type ConfigWebConversationItem = {
  sequence: number;
  type: ConfigWebConversationItemType;
  content: string;
  callId?: string;
  toolName?: string;
  role?: string;
  /** Payload char size when the content itself is not persisted (e.g. encrypted reasoning). */
  sizeHint?: number;
};

export type ConfigWebConversationDetails = {
  providerId: string;
  protocol: 'openai_chat_completions' | 'openai_responses';
  model: string;
  updatedAt: string;
  items: ConfigWebConversationItem[];
};

export type ConfigWebConversationPage = {
  id: string;
  total: number;
  offset: number;
  limit: number;
  items: ConfigWebConversationItem[];
};

export type ConfigWebMcpTool = {
  name: string;
  description?: string;
};

export type ConfigWebMcpServer = {
  name: string;
  type: 'http' | 'stdio';
  target: string;
  status: 'configured' | 'connecting' | 'connected' | 'failed';
  configPath: string;
  config: string;
  toolCount: number;
  tools: ConfigWebMcpTool[];
  error?: string;
  cwd?: string;
  envKeys?: string[];
};

export type ConfigWebMcpDetails = {
  path: string;
  servers: ConfigWebMcpServer[];
};

export type ConfigWebSkill = {
  name: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  baseDir: string;
  content: string;
  editable: boolean;
};

export type ConfigWebSkillsDetails = {
  root: string;
  skills: ConfigWebSkill[];
};

/**
 * 新会话的默认能力。会话自身的开关存在 session snapshot 里，这里只决定
 * 「以后新建会话时哪些默认打开」，不会改写已经存在的会话。
 */
export type ConfigWebCapabilityDefaults = {
  skills: Array<{ name: string; description: string }>;
  tools: ConfigWebCapabilityTool[];
  mcpServers: string[];
  disabledSkills: string[];
  disabledTools: string[];
  disabledMcpServers: string[];
};

/** 工具入参摘要：详情弹窗要能说清这个工具吃什么，不用去翻源码。 */
export type ConfigWebCapabilityToolParameter = {
  name: string;
  type: string;
  required: boolean;
  description: string;
};

export type ConfigWebCapabilityTool = {
  name: string;
  description: string;
  readOnly: boolean;
  parameters: ConfigWebCapabilityToolParameter[];
  /** 工具族：`null` 表示独立工具；有值时面板按组展示与按组开关。 */
  group: { key: string; label: string } | null;
};

export type ConfigWebPluginSource = 'official' | 'user';
export type ConfigWebPluginState = 'enabled' | 'disabled' | 'failed';
/** 插件设置项，形状与 `plugin.json` 里的 `settings` 声明一一对应。 */
export type ConfigWebPluginSetting = {
  key: string;
  label: string;
  type: 'text' | 'password' | 'textarea' | 'select' | 'number' | 'switch';
  description?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  default?: string;
  /** 必填项：页面在字段下方据此提示「需要填写」。 */
  required?: boolean;
  /** 这条会话可以单独覆盖（默认值仍由插件设置提供）。 */
  perSession?: boolean;
  /**
   * 属于哪一块面板。`llm` 表示由清单的 `llm` 声明生成，页面把它们收进同一个
   * 「模型接口」面板（带「测试连接」），而不是排进普通设置列表。
   */
  group?: 'llm';
  format?: 'url' | 'number';
  min?: number;
  max?: number;
  /** 数字项的步进（页面的 −/+ 按钮按它走），缺省 1。 */
  step?: number;
  /** 数字项的单位（`k tokens` / `分钟` / `次`）。 */
  unit?: string;
  pattern?: string;
};

export type ConfigWebPluginSettings = {
  fields: ConfigWebPluginSetting[];
  /** 当前生效值（已按声明过滤、补齐默认值）。 */
  values: Record<string, string>;
  /**
   * 当前值的校验问题。非空表示磁盘上的配置不可用——插件可能因此静默跳过工作，
   * 页面必须把原因显示出来，而不是继续显示「已保存」。
   */
  issues: { key: string; label: string; message: string }[];
};

/**
 * 插件声明的模型接口（清单 `llm`）。
 *
 * 四项配置字段本身仍在 `settings.fields` 里（`group: 'llm'`），这里只放面板需要的
 * 展示与状态：标题、说明、是否允许跟随主配置，以及「现在到底能不能用」。
 */
export type ConfigWebPluginLlm = {
  label: string;
  description: string;
  followMain: boolean;
  /** 生效配置的人读摘要（不含 Key）。 */
  summary: string;
  configured: boolean;
  /** 不跟随主配置时这几项必填，页面据此加标记。 */
  required: boolean;
};

/** 「测试连接」的结果：成功给出耗时，失败给出可直接照做的原因。 */
export type ConfigWebPluginLlmTest = {
  ok: boolean;
  message: string;
  latencyMs: number;
  model: string;
  reply?: string;
};

export type ConfigWebPlugin = {
  id: string;
  name: string;
  version: string;
  description: string;
  /**
   * 清单声明的图标名（kebab-case，取值见 `web/pluginIcons.tsx`）。空字符串表示清单没写，
   * 界面用默认图标兜底。
   */
  icon: string;
  author?: string;
  source: ConfigWebPluginSource;
  /** 启用 / 停用 / 加载失败。停用的插件在启动阶段就不会注册。 */
  state: ConfigWebPluginState;
  /** 官方插件是仓库内相对路径（plugins/<id>），用户插件是绝对路径。 */
  location: string;
  entryFile?: string;
  manifestFile: string;
  /** 清单声明了 settings 才有内容；没有声明时 `fields` 为空。 */
  settings: ConfigWebPluginSettings;
  /**
   * 清单里的 `llm` 声明：插件要自己调模型。
   *
   * 面板把 `settings.fields` 里 `group: 'llm'` 的那几项收在一起，配一个「测试连接」，
   * 页面因此只需要认识这一份数据，不用为每个插件各写一套模型表单。
   */
  llm: ConfigWebPluginLlm | null;
  /**
   * 插件依赖的桌面端运行条件（清单 `desktop.checks`）。文案与系统设置入口都来自宿主的
   * 检查目录，插件只声明 id——它跑在 app-server 子进程里，探测不到这些状态。
   */
  desktopChecks: ConfigWebPluginCheck[];
  /**
   * 清单的 `desktop.entry`：这个插件在桌面端侧栏里有一行入口，卡片内容由插件目录里的
   * `desktop.jsx` 渲染。`null` 表示它不占侧栏位置。
   *
   * 只有随包插件会被打包进页面，所以用户插件这一项永远是 null——声明了也画不出来，
   * 页面那边没有它的模块。
   */
  desktopEntry: ConfigWebPluginDesktopEntry | null;
  /**
   * 清单声明的运行状态行（清单 `status`）。值来自插件自己写的
   * `plugin-data/<id>/data.json`，宿主管不到插件的运行态，也就不替它编造；
   * 插件还没写过这个键时为 `null`，页面显示占位。
   */
  status: ConfigWebPluginStatusField[];
  /**
   * 清单的 `desktop.panel`：这个插件在对话右侧有一块面板（插件给数据、宿主渲染）。
   *
   * 与 `desktopEntry` 不同，它对**用户插件同样有效**——面板不需要前端模块，页面那边只按
   * 这份数据画按钮，点开源码在会话的 app-server 里问插件要视图。
   */
  desktopPanel: ConfigWebPluginDesktopPanel | null;
  /** 这个插件今天的日志文件（系统 temp 目录），排查时直接打开。 */
  logFile: string;
  /** 插件自报的最近一次状态（正常 / 待配置 / 出错）；没上报过为 null。 */
  health: ConfigWebPluginHealth | null;
  /** plugin-status.json 记录的上一次加载结果。 */
  loadStatus?: 'loaded' | 'registered' | 'failed' | 'skipped' | 'unknown';
  error?: string;
};

/** 桌面端侧栏入口的静态描述：清单只给文案，卡片内容是插件自己的模块。 */
export type ConfigWebPluginDesktopEntry = {
  label: string;
};

/** 一条运行状态：清单声明标签与类型，插件提供值。 */
export type ConfigWebPluginStatusField = {
  key: string;
  label: string;
  type: 'text' | 'link';
  /** 插件写下的值；`null` 表示它还没上报过这个键。 */
  value: string | null;
  /**
   * 这一行的语气。插件可以写成 `{ text, tone }` 表达「通/不通」，
   * 页面只按 `ok | warn | error` 上色，不解释语义。
   */
  tone: 'ok' | 'warn' | 'error' | null;
};

/**
 * 对话右侧面板的静态描述。
 *
 * `roles` 是显示条件：只有当前会话的角色命中时才出现（空数组表示任何角色都显示）。
 * 角色属于会话事实，插件不该在页面里自己去猜「现在是不是我要的那个角色」。
 */
export type ConfigWebPluginDesktopPanel = {
  label: string;
  roles: string[];
  /**
   * 输入框上方那排快捷按钮。`action` 直接触发插件动作，`section` 打开面板并展开那一块。
   */
  shortcuts: ConfigWebPluginPanelShortcut[];
};

export type ConfigWebPluginPanelShortcut = {
  label: string;
  action?: string;
  section?: string;
};

/** 一项运行条件的静态描述；此刻是否满足由 `readDesktopChecks()` 另取。 */
export type ConfigWebPluginCheck = {
  id: string;
  label: string;
  description: string;
  /** 系统设置面板地址；没有可打开的面板时为空（例如要用户自己装命令行工具）。 */
  pane?: string;
};

export type ConfigWebDesktopCheckStatus = {
  id: string;
  status: 'granted' | 'denied' | 'unknown';
  /** 探测到的具体信息，例如 clang 版本；没有可说的为空。 */
  detail: string;
};

export type ConfigWebDesktopChecks = {
  /** 当前宿主能不能真的探测：浏览器宿主不能（TCC 权限属于桌面应用进程）。 */
  supported: boolean;
  platform: string;
  checks: ConfigWebDesktopCheckStatus[];
};

/** 插件上报的健康快照，来自 `$MICA_HOME/plugin-health/<id>.json`。 */
export type ConfigWebPluginHealth = {
  level: 'ok' | 'warn' | 'error';
  message: string;
  /** 可选的处理建议，插件自己写。 */
  hint?: string;
  at: string;
};

export type ConfigWebPluginsDetails = {
  /** 用户插件目录（$MICA_HOME/plugins）。 */
  root: string;
  /** 启停状态文件（$MICA_HOME/plugins-state.json）。 */
  statePath: string;
  /** 官方插件在仓库里的目录。 */
  officialDir: string;
  plugins: ConfigWebPlugin[];
};

export type ConfigWebSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  turnState: 'running' | 'completed' | 'aborted' | 'error';
  providerId: string;
  model: string;
  role: string;
};

export type ConfigWebSessionUsage = {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  totalTokens: number;
};

/** Lightweight session header; heavy payloads are loaded lazily via separate endpoints. */
export type ConfigWebSessionDetails = ConfigWebSession & {
  fileSizeBytes: number;
  messageCount: number;
  usageCount: number;
  contextWindowSize?: number;
  lastUsage?: ConfigWebSessionUsage;
};

export type ConfigWebContextEntry = {
  sequence: number;
  type: ConfigWebConversationItemType;
  label: string;
  tokens: number;
  preview: string;
  images?: number;
};

/**
 * 上下文占用的类别。同一份 provider 历史可能是两种形态：
 * - Chat Completions：`{ role, content, tool_calls }` / `{ role: 'tool', tool_call_id }`
 * - Responses：扁平的 `{ type: 'message' | 'function_call' | 'function_call_output' | 'reasoning' }`
 *
 * `envelope` 是每条消息的 role / type / call_id / name 等结构字段——线上请求同样会带上，
 * 混进正文会让「持久化消息体」明显偏小、差额全被算成 system prompt。
 */
export type ConfigWebContextKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'envelope'
  | 'other';

export type ConfigWebContextCategory = {
  kind: ConfigWebContextKind;
  count: number;
  chars: number;
  tokens: number;
};

export type ConfigWebContextToolCall = {
  id?: string;
  name?: string;
  arguments?: string;
};

/** 逐条明细：一条持久化消息贡献的体积。`parts` 是它按类别拆开的字符数。 */
export type ConfigWebContextItem = {
  /** 1-based，按持久化顺序；排序后仍能指回原位置。 */
  sequence: number;
  kind: ConfigWebContextKind;
  chars: number;
  tokens: number;
  parts: Partial<Record<ConfigWebContextKind, number>>;
  content?: string;
  role?: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ConfigWebContextToolCall[];
  cleared?: boolean;
  truncated?: boolean;
  hasImage?: boolean;
  imageCount?: number;
  mediaCount?: number;
  encryptedChars?: number;
};

/** 最近一次请求的 input 已被 compact / 裁剪作废时，作废原因与两个数字。 */
export type ConfigWebContextStaleInput = {
  inputTokens: number;
  reason: 'compacted' | 'truncated';
  compactedAt?: string;
  compactedTokens?: number;
  recordedMessages?: number;
  currentMessages?: number;
};

export type ConfigWebContextTurn = {
  /** 1-based turn number; 0 for a session without any user message. */
  index: number;
  userSequence: number;
  userPreview: string;
  conversationTokens: number;
  toolTokens: number;
  thinkingTokens: number;
  totalTokens: number;
  /** Real input tokens at the end of this turn, from usage history when aligned. */
  contextTokens?: number;
  cachedInputTokens?: number;
  usageRequests: number;
  entries: ConfigWebContextEntry[];
};

export type ConfigWebContextAnalysis = {
  providerId: string;
  model: string;
  contextWindowSize?: number;
  imageCount: number;
  turnCount: number;
  totals: {
    conversationTokens: number;
    toolTokens: number;
    thinkingTokens: number;
    totalTokens: number;
  };
  turns: ConfigWebContextTurn[];
  /** 持久化消息体（含结构字段）的估算：chars/4，与 CLI 的 ctx 同口径。 */
  messageChars: number;
  messageTokens: number;
  clearedResults: number;
  categories: ConfigWebContextCategory[];
  items: ConfigWebContextItem[];
  /** 最近一次真实请求的 input；快照在请求之后被改写时留 0（见 `staleInput`）。 */
  lastInputTokens: number;
  staleInput: ConfigWebContextStaleInput | null;
  /** 本会话出现过的最小请求 input：固定开销（system prompt + 工具 schema）的上界。 */
  fixedOverheadTokens: number;
  overheadTokens: number;
};

export type ConfigWebSessionOption = {
  id: string;
  title: string;
  updatedAt: string;
  /** 列表里用来区分同名会话：工作目录末两级、模型、状态各占一行信息。 */
  cwd?: string;
  model?: string;
  turnState?: string;
  sizeBytes?: number;
};

export type ConfigWebSessionsDetails = {
  root: string;
  sessions: ConfigWebSessionOption[];
};

export type ConfigWebRole = {
  name: string;
  content: string;
  builtIn: boolean;
  path?: string;
};

export type ConfigWebRolesDetails = {
  root: string;
  roles: ConfigWebRole[];
};

export type ConfigWebBrowserControlEndpointParam = {
  name: string;
  in: string;
  required: boolean;
  description: string;
};

export type ConfigWebBrowserControlEndpoint = {
  id: string;
  method: string;
  path: string;
  summary: string;
  params: ConfigWebBrowserControlEndpointParam[];
  returns?: string;
  example?: string;
};

export type ConfigWebBrowserControlBrowser = {
  id: string;
  owner: string | null;
  label: string;
  title: string;
  url: string;
  visible: boolean;
  loading: boolean;
  activeTabId: string | null;
  tabs: Array<{ id: string; title: string; url: string; active: boolean }>;
};

/** 受控浏览器服务的完整视图：能力文档 + 当前窗口列表。只有桌面运行时提供。 */
export type ConfigWebBrowserControlDetails = {
  available: boolean;
  serviceUrl: string | null;
  /** agent 接入用的 MCP 端点（`/mcp/browser`），会话启动时写进 `--mcp-config`。 */
  mcpUrl: string | null;
  /** MCP 工具名（固定单工具 `control`）。 */
  toolName: string;
  version: number;
  error: string | null;
  browsers: ConfigWebBrowserControlBrowser[];
  endpoints: ConfigWebBrowserControlEndpoint[];
  /** 完整人读文档（markdown 源文）。 */
  markdown: string;
  /** 写给 agent 的技能文档源文。 */
  /** 环境变量名：agent 用 `url` 拿地址、用 `owner` 认领归属。 */
  envVars: { url: string; owner: string };
};

export type ConfigWebBrowserControlWindowInput = {
  url?: string;
  label?: string;
  owner?: string;
  show?: boolean;
};

export type ConfigWebBrowserControlWindowTarget = {
  id: string;
  focus?: boolean;
};

/**
 * 终端控制里的一个会话：真实 PTY + 登录 shell，窗口按需挂在应用后台。
 * 字段与 `apps/desktop/src/host/terminal-control-core.js` 的归一化结果一一对应。
 */
export type ConfigWebTerminalControlSession = {
  id: string;
  owner: string | null;
  label: string;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  createdAt: string | null;
  updatedAt: string | null;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  windowVisible: boolean;
  outputSeq: number;
  truncated: boolean;
};

/** 终端控制服务的完整视图：能力文档 + 当前会话列表。只有桌面运行时提供。 */
export type ConfigWebTerminalControlDetails = {
  available: boolean;
  serviceUrl: string | null;
  /** agent 接入用的 MCP 端点（`/mcp/terminal`），会话启动时写进 `--mcp-config`。 */
  mcpUrl: string | null;
  /** MCP 工具名（固定单工具 `control`）。 */
  toolName: string;
  version: number;
  error: string | null;
  sessions: ConfigWebTerminalControlSession[];
  /** 与受控浏览器共用同一份端点描述形状（两份服务从各自的端点目录生成文档）。 */
  endpoints: ConfigWebBrowserControlEndpoint[];
  /** 完整人读文档（markdown 源文）。 */
  markdown: string;
  /** 环境变量名：agent 用 `url` 拿地址、用 `owner` 认领归属。 */
  envVars: { url: string; owner: string };
};
