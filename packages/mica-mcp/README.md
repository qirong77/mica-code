# mica-mcp

`mica-mcp` 负责读取 MCP 配置、管理 MCP server 连接，并把远端 MCP tools 注册到 `mica-tools`。

## 主要能力

- 初始化所有 MCP server：`micaMcp.init()`。
- 重新连接指定 server：`micaMcp.reconnectServer(...)`。
  工具定义按 server 保留最近一次成功快照；只替换本次重连的 server，不为了重连 A 去刷新 B 的
  `tools/list`。B 暂时不能列工具时仍保留原代理，真正断开后才清理。重连目标的 connect/list
  失败会清理该次连接与该 server 的工具，不影响其他已连 server。
- 关闭连接并清理工具注册：`micaMcp.shutdown()`。
- 读取 MCP 配置：`micaMcp.loadConfig()`。
- 从显式路径严格读取 MCP 配置：`micaMcp.readConfig(path)`。
- 展开配置里的环境变量占位符：`micaMcp.expandEnv(value)`。
- 暴露 MCP server 状态 store：`micaMcp.servers`。
- stdio stderr 只累计有界字节计数，不记录命令、env、口令或 stderr 原文；transport error/close 更新失败状态并撤下活连接，使旧工具不能继续执行。主动 cleanup 不记为故障。初始化失败仍通过原有连接错误响应给调用方，不冒充已经完成真实连接验证。
- 拼会话能力目录的 MCP 一栏：`micaMcp.catalog({ configured, extra, statuses })`——用户配置、
  会话自己的 `--mcp-config`、已连上的 server 三处合并。桌面端把受控浏览器 / 终端挂在会话
  `--mcp-config` 上而不写用户配置，能力目必须把这一处也算进去。
- 工具结果支持文本与图片：纯文本保持字符串返回与 60,000 字符限长；图片映射为 `mica-tools`
  的标准 base64 image block，混合内容保留块顺序，只有文本块参与限长，图片数据不转成文本或截断。
  支持 `image/jpeg`、`image/png`、`image/gif`、`image/webp`；文本资源与资源链接保留为文本，
  其他图片 MIME、音频与二进制资源返回简短的不支持说明，不把二进制或未知内容 JSON 序列化进
  上下文。`isError` 仍按文本错误抛出。
- 远端图片和本地 `read_image` 走同一道入口保护：base64 解码后交给 `prepareImageForApi`
  （`mica-common/image.ts`）。逐张顺序处理（不并发解码多张大图），PNG 长边超过 1568 就按面积平均
  缩小并无损重编码，长边仍超接口上限 8192 的图在本机拦下，不让请求换来服务端 400。缩小过的图
  前面会插一段说明原始/实际尺寸，并提示要看清细节应让 MCP 工具裁剪、按区域分段重截或分段读。
  image block 的 `media_type` 用实际识别出的格式，不信任 MCP 声明的 `mimeType`：服务端把 JPEG
  标成 PNG 时按声明发出去只会换来一条「不认识的图片格式」。单张失败（空载荷、图头不认识、尺寸
  超限）只换成一行简短说明，同一结果里的其它图文照常保留；说明与报错文案都不会带上 base64 载荷。

桌面端浏览器 MCP 的 `screenshot` 默认按 `raw=true` 返回模型可见的图片；需要 JSON dataUrl 时可
显式传 `raw=false`。这只改变 MCP 调用默认值，直接 HTTP 截图接口仍默认返回 JSON。

受控 browser/terminal MCP 将声明的 action `timeoutMs` 加 5 秒传输余量作为 socket 预算（至少 30 秒），并贯穿 SDK/HTTP AbortSignal；取消/超时显式结算 Promise 与关闭请求，不依赖 Bun 的 node:http 在响应头前发出 error。普通 MCP tools/call 保留 120 秒缺省预算，显式更长预算只延长传输等待，不重试或重复业务动作。

## 使用入口

```ts
import { micaMcp } from '../packages/mica-mcp/index.js';

await micaMcp.init();

// Headless/managed runtime: explicit servers override local servers.
await micaMcp.init({ configPath: '/tmp/mcp.json' });

// Strict mode does not merge ~/.mica/config.json.
await micaMcp.init({ configPath: '/tmp/mcp.json', strict: true });

// Headless cancellation is forwarded to connect/list/call requests.
await micaMcp.init({ signal: abortController.signal });

// Managed one-shot runtime: initialize servers concurrently and bound each
// server's complete connect + tools/list phase.
await micaMcp.init({ parallel: true, initTimeoutMs: 3000 });
```

## 环境变量展开

`url` 与 `headers` 的值支持 `${VAR}` 与 `${VAR:-默认值}`，在 `loadConfig` / `readConfig`
读取时展开。变量未定义（或为空串）且没写默认值时展开为空字符串。

```json
{
  "mcpServers": {
    "mica-browser": {
      "type": "http",
      "url": "http://127.0.0.1:${MICA_DESKTOP_PORT:-8787}/mcp/browser"
    }
  }
}
```

桌面端的 MCP 端点跟着运行时端口走，写死端口会在 `MICA_DESKTOP_PORT` 改动或端口回退后
静默连到别的实例。`command` / `args` / `env` 不展开：那几个值属于子进程自己的语义，
提前吃掉 `${...}` 会破坏用户想原样传下去的变量。

## 设计约束

- MCP server 的生命周期由本包统一管理。
- 远端工具必须通过 `mica-tools` 的注册入口接入，不绕开工具 registry。
- 重连或关闭 server 时需要同步清理对应工具，避免留下失效工具定义。
- 配置读取与连接状态更新应保持可观测，便于 `/mcp` 命令展示。
- `loadConfig` 对缺失/损坏配置保持空集合回退；`readConfig(path)` 会把显式托管文件错误交给调用方处理。
- MCP connect、tools/list 和 tools/call 都应传递 agent 的 AbortSignal；不要让 headless 取消等待默认超时。
- `tools/call` 保留原有 120 秒默认等待下限；输入显式声明更长的 `timeoutMs`（顶层或 `params`）时，
  传输等待扩展为该预算加 5 秒响应余量，而不是提前结束合法长等待。调用方 AbortSignal 仍可随时
  取消；计时器最大值限制在 SDK/Node 支持的有符号 32 位范围，避免溢出变成立即超时。
- `initTimeoutMs` 是单个 server 的完整初始化截止时间，不会为 connect 和 tools/list 分别重新计时；本地截止只标记该 server 失败并继续，外部 AbortSignal 仍会终止整个初始化。
- `parallel: true` 并发初始化独立 server，但最终工具顺序仍按配置顺序合并。
- stdio server 使用 pipe 隐藏 stderr 时仍必须持续 drain；否则服务端大量诊断输出会填满 pipe 并阻塞协议进程。

## 目录说明

- `config.ts`：MCP 配置路径、配置类型和加载逻辑。
- `client.ts`：MCP client 与连接状态。
- `service.ts`：初始化、重连和关闭编排。
- `tools.ts`：MCP tool 到 Mica tool 的适配，保留文本资源与资源链接；图片经 `prepareImageForApi`
  压缩/拦截后再变成 image block，二进制资源只返回简短说明。
- `operation.ts`：桌面独立插件后端复用的内部 operation 观察适配，仍由 `mica-diagnostics` 的
  `logger/timedResult` 负责唯一计时、聚合与轮转。事件 `operation.start/finish` 只含随机 operationId、
  固定 operation 名、可信插件 id，以及 `outcome/code/ms`；不复制输入、输出、异常消息或堆栈，
  不伪造 Agent run。`{ ok:false, error }` 与 MCP `isError` 均记为失败；调用方取消/截止分别记为
  `cancelled/aborted`、`timeout/timeout`。等待沿用调用方 signal，不另设 30 秒截止；不配合取消的
  插件仍可能在后台继续，观察层仅结算等待，不能撤销已发生的写入。
- `index.ts`：公共 API 聚合导出。
