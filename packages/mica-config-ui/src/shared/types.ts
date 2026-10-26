export type ConfigWebSection =
  | 'config'
  | 'sessions'
  | 'roles'
  | 'mcp'
  | 'skills'
  | 'capabilities'
  | 'plugins'
  | 'autoCompact'
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
export type ConfigWebPluginFile = { name: string; sizeBytes?: number };

/** 插件设置项，形状与 `plugin.json` 里的 `settings` 声明一一对应。 */
export type ConfigWebPluginSetting = {
  key: string;
  label: string;
  type: 'text' | 'password' | 'textarea' | 'select' | 'number';
  description?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  default?: string;
  /** 必填项：页面在字段下方据此提示「需要填写」。 */
  required?: boolean;
  format?: 'url' | 'number';
  min?: number;
  max?: number;
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

export type ConfigWebPlugin = {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  source: ConfigWebPluginSource;
  /** 启用 / 停用 / 加载失败。停用的插件在启动阶段就不会注册。 */
  state: ConfigWebPluginState;
  /** 官方插件是仓库内相对路径（plugins/<id>），用户插件是绝对路径。 */
  location: string;
  entryFile?: string;
  manifestFile: string;
  files: ConfigWebPluginFile[];
  /** 清单声明了 settings 才有内容；没有声明时 `fields` 为空。 */
  settings: ConfigWebPluginSettings;
  /** 这个插件今天的日志文件（系统 temp 目录），排查时直接打开。 */
  logFile: string;
  /** 插件自报的最近一次状态（正常 / 待配置 / 出错）；没上报过为 null。 */
  health: ConfigWebPluginHealth | null;
  /** plugin-status.json 记录的上一次加载结果。 */
  loadStatus?: 'loaded' | 'registered' | 'failed' | 'skipped' | 'unknown';
  error?: string;
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

export type ConfigWebAutoCompactSettings = {
  enabled: boolean;
  quickThresholdK: number;
  quickLimit: number;
  modelThresholdK: number;
  modelLimit: number;
  /** 两次压缩之间的最小间隔（毫秒）；页面上按分钟编辑，0 表示不限制。 */
  minIntervalMs: number;
};

/** 一个会话的自动压缩账本（计数只是展示用的，丢了不影响压缩本身）。 */
export type ConfigWebAutoCompactCounter = {
  sessionId: string;
  /** 会话文件还在时是它的标题；会话被删了就只剩 id。 */
  title?: string;
  quickRuns: number;
  modelRuns: number;
  lastRunAt: string | null;
  lastKind: 'quick' | 'model' | null;
  lastSavedTokens: number;
  lastNote: string | null;
};

export type ConfigWebAutoCompactDetails = {
  /** 落盘位置（运行时目录下的 auto-compact.json），页面上直接展示。 */
  path: string;
  settings: ConfigWebAutoCompactSettings;
  /** 运行时的默认值，页面用它实现「恢复默认」。 */
  defaults: ConfigWebAutoCompactSettings;
  counters: ConfigWebAutoCompactCounter[];
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
};

export type ConfigWebSessionOption = {
  id: string;
  title: string;
  updatedAt: string;
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
