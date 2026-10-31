# 可复现的产品演示截图

截图使用真实 Web 运行时、工具执行和浏览器界面，模型端由本地 Responses SSE 脚本替代。示例项目是一个独立的 Node 任务队列；不使用个人项目、真实密钥或真实模型。模拟服务不会转发请求。用量字段固定为 0，是演示占位值，不能当成 token、缓存命中率或性能测量；对外展示截图时注明“本地脚本演示，模型用量为演示值”。

## 1. 准备独立目录

需要 Node 22+、Git，以及已构建的 CLI、Web renderer 和 Node Web 运行时。从仓库根目录开始：

```bash
export DEMO_REPO="$PWD"
export MICA_DEMO_PROVIDER_PORT=8898
export DEMO_ROOT="$(node scripts/prepare-doc-demo.mjs | node --input-type=module -e 'let text = ""; for await (const chunk of process.stdin) text += chunk; console.log(JSON.parse(text).root)')"
export DEMO_WORKSPACE="$DEMO_ROOT/workspace/task-queue"
export MICA_HOME="$DEMO_ROOT/home"
export MICA_DESKTOP_USER_DATA="$DEMO_ROOT/data"
export MICA_DESKTOP_PORT=8899
export MICA_DESKTOP_HOST=127.0.0.1
export MICA_DESKTOP_RENDERER="$DEMO_REPO/apps/desktop/out/renderer"
export MICA_DESKTOP_EXIT_ON_STDIN_CLOSE=0
export MICA_LOG_DIR="$DEMO_ROOT/logs"
mkdir -p "$DEMO_ROOT/bin"
cp "$DEMO_REPO/dist/mica" "$DEMO_ROOT/bin/mica"
chmod u+x "$DEMO_ROOT/bin/mica"
export MICA_CLI_PATH="$DEMO_ROOT/bin/mica"
printf 'Demo root: %s\nWorkspace: %s\n' "$DEMO_ROOT" "$DEMO_WORKSPACE"
```

默认根目录由 `os.tmpdir()` 下的 `mkdtemp` 创建，名称以 `mica-docs-demo-` 开头。也可运行 `node scripts/prepare-doc-demo.mjs /absolute/demo/path` 指定新目录或空目录。脚本拒绝仓库内部目录、仓库祖先目录、符号链接根目录和非演示的非空目录。

准备脚本创建 `home/config.json`、独立 `data/`、`logs/` 和 `workspace/task-queue/`，并在示例仓库中提交基线。示例无需安装依赖：`src/task-queue.mjs`、`test/task-queue.test.mjs` 和 `package.json` 使用 Node 原生测试。运行前可在独立 workspace 执行 `node --test`，基线有 2 项测试。

配置字段已经对照 `packages/mica-config/types.ts`：provider 是 `demo`，模型是 `mica-demo`，协议是 `openai_responses`，API 为 `http://127.0.0.1:8898/v1`，key 为明确的假值。模型和推理档位选择放在 workspace 对应的 `home/storage.json` 中，provider 用 `effortLevels` 声明 `low/medium/high`，默认选择 `medium`。不要向配置添加未经支持的 `reasoning_effort` 或 `autoDetect` 开关。

自动探测通过明确的数据控制：provider 固定 `models`，不设置动态模型列表的 `get_model_url`，`mcpServers` 为空，并写入当天的本地 `home/cache/models-dev.json`，避免元数据联网刷新。该缓存有效期为 24 小时，跨天应重新准备。`session-rename`、`memory`、`auto-compact` 和 `mobile-relay` 在独立 `plugins-state.json` 中停用，避免额外模型请求或后台行为；`todo` 保持启用。

## 2. 启动模拟服务与 Node Web 运行时

以下两个进程需要保持运行。把前一步打印的环境带入各自终端；也可以用后台任务工具启动，并将输出写入独立日志目录。

模拟服务：

```bash
node "$DEMO_REPO/scripts/demo-mock-provider.mjs" "$MICA_DEMO_PROVIDER_PORT"
```

默认每次响应与工具事件之间有少量延迟，便于拍摄进行中的画面。需要快速验证时使用 `MICA_DEMO_DELAY_SCALE=0`；正常截图使用默认值 `1`。健康检查为 `http://127.0.0.1:8898/health`。

运行 Web 宿主前清除继承自另一个桌面实例的控制 socket，避免连接既有实例。使用 Node 直接启动构建产物：

```bash
unset MICA_BROWSER_URL MICA_BROWSER_SOCKET MICA_TERMINAL_URL MICA_TERMINAL_SOCKET
unset MICA_DESKTOP_ORIGIN MICA_PLUGIN_DESKTOP_HOST
node "$DEMO_REPO/apps/desktop/out/server/index.mjs"
```

当前 `apps/desktop/vite.server.config.mjs` 将 `src/server/index.js` 构建为 **`out/server/index.mjs`**，不是 `out/server/index.js`。请按实际产物扩展名启动。这个进程使用 Node 和 Electron shim，不启动 Electron。不要用 `npm run dev` 或 `electron-vite preview` 拍摄。

缺少产物时，先由主工作区完成构建：CLI 是 `bun run build`，Node Web 运行时是 `npm --prefix apps/desktop run build:server`；renderer 可在 `apps/desktop` 执行 `npx electron-vite build --ignoreConfigWarning`，这是构建命令，不会启动 Electron。构建完成后重新复制 CLI 到演示 `bin/`。不要用这些构建命令替换上面的 Node 启动命令。

用浏览器打开 `http://127.0.0.1:8899`。`MICA_HOME`、`MICA_DESKTOP_USER_DATA`、`MICA_DESKTOP_PORT`、`MICA_CLI_PATH`、`MICA_LOG_DIR` 必须同时设置，避免使用个人会话、已安装的旧 CLI 或默认端口。显式指定 `MICA_DESKTOP_RENDERER`，避免继承已运行桌面实例的旧资源路径。若端口已被占用，更换端口并核对启动日志中的实际地址，不要连到已有实例。

## 3. 通过真实 chat:start 启动演示

实际入口是 `POST /api/invoke`，请求体为 `{ "channel": "chat:start", "payload": { ... } }`。`payload.id` 是客户端聊天节点 id，`prompt` 是用户输入，`cwd` 必须是独立示例 workspace，`model` 可使用 `demo/mica-demo` 指定 provider 和模型，推理档位字段为 `variant`。新会话不传 `sessionId`，由运行时创建；续聊才传已有的 session id。

下面的可运行示例先执行修改任务，再生成两条只读会话供侧栏展示，并轮询真实运行状态。它会核对 HTTP 包装层和 `chat:start` 的结果；任务成功与否仍以工具输出、测试输出和最终回答为准。

```bash
node --input-type=module <<'NODE'
import { setTimeout } from 'node:timers/promises';
const origin = `http://127.0.0.1:${process.env.MICA_DESKTOP_PORT || 8899}`;
const cwd = process.env.DEMO_WORKSPACE;
if (!cwd) throw new Error('Export DEMO_WORKSPACE first');
async function invoke(channel, payload) {
  const response = await fetch(`${origin}/api/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, payload }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json();
  if (!response.ok || !body.ok || body.result?.ok === false) {
    throw new Error(JSON.stringify(body));
  }
  return body.result;
}
for (const [id, prompt] of [
  ['docs-demo-abort', '为任务队列补充 AbortSignal 支持，并验证取消行为'],
  ['docs-demo-fifo', '只读：解释任务队列如何保持 FIFO 串行执行'],
  ['docs-demo-tests', '只读：梳理取消行为的测试边界'],
]) {
  await invoke('chat:start', { id, prompt, cwd, model: 'demo/mica-demo', variant: 'medium' });
  const deadline = Date.now() + 120000;
  let state;
  do {
    if (Date.now() > deadline) throw new Error(`Timed out: ${id}`);
    await setTimeout(400);
    state = await invoke('chat:is-running', { id });
  } while (state.running);
  console.log(JSON.stringify({ id, sessionId: state.sessionId, running: state.running }));
}
NODE
```

模拟脚本先执行 workspace 标记检查，然后真实调用 `todo_write`、`grep_search`、`read_file`、`apply_patch` 和 `run_shell`。所有文件路径相对示例 workspace；超时使用 `timeout_ms` 毫秒。补丁增加三条取消测试，总计 5 项。验证命令为 `node --test --test-reporter=tap`，显式固定报告格式，避免不同 Node 版本的默认 reporter 影响结果识别。脚本只有在工具返回包含 5 项通过、0 项失败和 `exit_code: 0` 时，才会更新为完成状态并报告通过。遇到工具失败或缺少证据会明确停止，不返回固定的成功战报。

实现支持提前取消、排队取消和运行中协作取消。正在运行的任务仍需要自行响应 `signal` 并结束；队列会等待它完成清理，避免与下一项并行。没有性能测试，也不展示推测出的性能数据。

脚本步骤从当前轮次的 Responses `function_call_output` 推导，不使用全局会话游标。Responses SSE 保留创建、推理摘要、工具参数、工具完成、文本增量及响应完成事件。两个只读话题只读取示例文件，不更改项目。

## 4. 截图与固定产物

通过受控浏览器打开独立实例。API 任务完成后刷新会话列表，打开“为任务队列补充 AbortSignal 支持，并验证取消行为”对应会话。确认文件改动与 5 项测试输出可见。需要拍摄进行中的过程时，在新准备的 workspace 运行同一任务，避免对已修改文件重复应用基线补丁。

| 画面 | 根 README 产物 | 官网产物 | 建议内容 |
| --- | --- | --- | --- |
| 桌面工作区 | `images/app-chat.png` | `apps/website/public/screenshots/chat.png` | 会话侧栏、任务结果与真实测试终端；1440×900 |
| 执行过程 | `images/app-turn-log.png` | `apps/website/public/screenshots/turn-log.png` | 展开计划、补丁及真实 `node --test` 输出；1600×1000 |
| 手机布局 | `images/app-mobile.png` | `apps/website/public/screenshots/mobile.png` | 同一会话的窄屏布局；390×844 |

每个画面以真实浏览器截图为源，对应 README 和官网使用同一张图。截图前确认没有个人路径、凭证、其他项目和旧的示例结果。图片说明应注明本地脚本演示与用量占位值。终端验证可执行 `node --test && git --no-pager diff --stat`，避免 Git 分页器遮住测试结果。手机画面使用 390×844 移动视口重新加载页面，等侧栏收起动画完成后截图；不需要开启中转插件或暴露远程入口。

截图结束后，在独立 workspace 执行 `node --test` 与 `git diff --check` 复核。确认 5 项测试通过，`git status --short` 仅有两个示例源码/测试文件变更。主仓库不会被演示工具改动；它只接收本页列出的截图产物。

停止两个后台进程后，可保留临时目录供复查。重拍时优先创建新的临时目录；如确需重置，运行 `node scripts/prepare-doc-demo.mjs "$DEMO_ROOT" --reset`。该操作只接受带有本脚本标记的演示目录，重建 `home/`、`data/`、`logs/` 和 `workspace/`，随后重新启动模拟服务和 Web 运行时。不得在运行中的演示实例上重置。
