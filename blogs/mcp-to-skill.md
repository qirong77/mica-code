# 把两个 MCP 变成 Skill：卸载 37 个常驻工具

> 本文是 [mica-code](https://github.com/qirong77/mica-code) 系列文章之一。mica-code 是一个从零搭建的 CLI code agent，基于 Bun + TypeScript + React（Ink）+ Anthropic SDK，目标是搞清楚 Claude Code 这类工具底层到底怎么工作。

有一天我看了一眼我的 `~/.mica/config.json`，发现 `mcpServers` 里躺着三个 server：

```json
{
  "Cooper": { "url": "http://127.0.0.1:28582/v1/hub/cooper_mcp" },
  "mock-mcp-server": { "url": "http://mock.xiaojukeji.com/mcp" },
  "sequential-thinking": { "command": "npx ..." }
}
```

前两个加起来有 **37 个工具**——Cooper 31 个（文档、表格、知识库、协作者、评论、标签、上传下载），mock 6 个（接口列表、详情、导入、upsert、分类、导出）。

问题不是它们不好用，而是**我很少用**。可它们每天都会跟着 agent 启动，37 份工具定义每轮对话都完整发送给模型。

这就像在家里装了 31 台打印机，哪怕你一个月只打印一次，它们也每天通电待机。

---

## 一、先量化：这到底值多少钱

直觉告诉我浪费，但得先量化。工具定义在 mica-code 里是这样注入 system prompt 的（`packages/mica-tools/registry.ts`）：

```ts
export function getToolDefinitions(filter?: ToolFilter): Tool[] {
  return getAllToolsForPrompt()
    .filter((t) => toolAllowed(t, t.name, filter))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }));
}
```

也就是说，每个 MCP 工具的 `name + description + input_schema` 会以 JSON 形式常驻每一轮请求。

我直接对两个 server 发 `tools/list`，把原始定义拉出来，再用项目自己的 token 估算算法（`packages/mica-builtin-commands/commands/context.tsx` 里的 `estimateTokens`：`ASCII/4 + CJK/1.5`）量一遍：

| 来源            | 工具数 | 定义文本        | 估算 tokens |
| --------------- | ------ | --------------- | ----------- |
| Cooper MCP      | 31     | 15,267 字符     | ≈ 4,732     |
| mock-mcp-server | 6      | 5,591 字符      | ≈ 1,721     |
| **合计**        | **37** | **20,858 字符** | **≈ 6,453** |

**6,453 tokens，每轮对话都在烧。** 一轮 20 次请求的会话就是约 12.9 万 tokens，够我跑好几轮正经代码任务了。

这还没算两个隐性成本：每次启动 mica 都要连接两个 MCP server（Cooper 是本地 hub，快；mock 是远程，握手加 `tools/list` 稳定 1 秒+，偶尔更久）；37 个工具名也在干扰模型的工具选择——模型要在 50+ 个工具里挑对的那个，候选越多，挑错的概率越大。

---

## 二、为什么不用"禁用开关"？

第一反应是找配置里有没有 `"enabled": false` 之类的开关。翻 `packages/mica-mcp/config.ts`：

```ts
export type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;

export async function loadMcpConfig(path = MCP_CONFIG_PATH): Promise<Record<string, McpServerConfig>> {
  try {
    return await readMcpConfig(path);
  } catch {
    return {};
  }
}
```

配置类型里只有 `command` / `args` / `env` / `url` / `headers`，**没有 enabled 字段**。`loadMcpConfig` 会把 `mcpServers` 里所有 server 全部连接、注册工具。

两个选择：

1. **给 mica 加一个 enabled 开关**——改产品代码，让 MCP 支持禁用。这是"给所有用户加一个通用能力"。
2. **把这两个 MCP 从配置里移走，改造成 Skill**——只解决我自己的问题，还能顺便验证一个我一直想验证的想法：**MCP 和 Skill 不是互斥的，MCP 的底层能力完全可以被 Skill 封装成按需加载的形态。**

我选了 2。改产品代码的边际成本高，而且"把不常用的 MCP 变成 Skill"本身就是对 `agent-skills.md` 那篇"渐进披露"思想的实践——**MCP 负责外部连接，Skill 负责按需装载，两者可以叠加，而不是二选一。**

---

## 三、Skill 里到底放什么

每个 Skill 是一个目录 + `SKILL.md`。我建了两个：

```text
~/.mica/skills/
  cooper/
    SKILL.md
    scripts/cooper.sh
  mock-mcp/
    SKILL.md
    scripts/mock.sh
```

`SKILL.md` 的 frontmatter 是门面——**决定模型什么时候会触发它**：

```yaml
---
name: cooper
description: Read, create, and edit Cooper documents, sheets, knowledge bases, comments, tags, and collaborators through the local Cooper MCP hub. Use when the user mentions Cooper docs, Cooper sheets/tables, 知识库/知识库页面, 协作文档, 协作者/权限, 文档评论/标签, 上传文件到 Cooper, or asks to search or operate on their Cooper content.
when_to_use: Use whenever the user asks to read, create, edit, search, share, comment, tag, or manage Cooper 文档/表格/知识库/协作者, or mentions Cooper resource IDs like TT3b35cdMEd6.
argument-hint: '[tool] [json args]'
---
```

正文则是"专家工作手册"：端点、鉴权、工具清单表格、参数说明、常用流程、注意事项。我把从 `tools/list` 拉到的 37 个工具的真实 schema 信息整理进去——包括那些容易踩的坑：

- `createCooperSheet` 返回 `docId` 和 `resourceId` 两个 ID，**后续读写必须用 `resourceId`**；
- `createCooperDocument` 的标题**禁止包含正则元字符** `[ ] ( ) { } . * + ? ^ $ \ |`，否则报 `Illegal character range`；
- `updateKnowledgeDocumentV2` 的推荐流程是 `pull → locate → apply`，每次 apply 后要重新 pull，不要用 `readContent` 做定位。

这些细节如果还是常驻工具，模型每次都能看到（也每次都在付钱）；变成 Skill 后，只有真用 Cooper 时才会读到。

---

## 四、封装脚本：把 MCP 协议变成两行命令

关键问题来了：从常驻工具移除后，agent 怎么调用这两个 server？

选项 A：让 Skill 直接指挥 agent 手写 curl 调 MCP。太脆弱——Streamable HTTP MCP 的握手、SSE 解析、session 管理，每一步都是坑。

选项 B：写一个薄封装脚本，把"工具名 + JSON 参数"映射成一次 curl，输出 `result.content` 的文本。agent 只需要：

```bash
bash "~/.mica/skills/cooper/scripts/cooper.sh" listCooperSpaces '{"type":1}'
bash "~/.mica/skills/mock-mcp/scripts/mock.sh" get_mock_interface_details '{"id":963940,"token":"..."}'
```

我选了 B。两个脚本的复杂度差别很大，正好展示了 MCP 实现的多样性。

### Cooper：无状态，一次请求搞定

本地 hub，发一次 `tools/call` 就返回，不需要 session。核心就是构造 JSON-RPC 请求、解析 SSE 响应：

```bash
HTTP_CODE=$(curl -sS -m 60 -o "$TMP" -w "%{http_code}" \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: $AUTH" \
  -d "$BODY" || true)
```

注意 `Accept: application/json, text/event-stream`——**这是必须的**。两个 server 都要求客户端同时接受 JSON 和 SSE，只写 `application/json` 会得到：

```json
{
  "jsonrpc": "2.0",
  "error": {
    "code": -32000,
    "message": "Not Acceptable: Client must accept both application/json and text/event-stream"
  }
}
```

响应解析也写了 Python 兜底：SSE 格式是 `data: {json}` 行，Cooper 返回的就是这种；解析时逐行找 `data:` 前缀，找不到再按纯 JSON 解析。

### Mock：要 session，还有 TTL

mock 是标准的 Streamable HTTP MCP 实现：**必须先 `initialize`，从响应头拿 `Mcp-Session-Id`，后续请求都要带这个头**。不带就是：

```json
{ "jsonrpc": "2.0", "error": { "code": -32000, "message": "Bad Request: No valid session ID provided" } }
```

而且 session 可能过期——`No valid session ID` 一旦出现，脚本要自动重新 `initialize` 并重试一次。脚本里做了三件事：

1. 首次调用时 `initialize`，从响应头 `grep mcp-session-id`，缓存到 `/tmp/mock-mcp-session-<uid>.txt`（带时间戳，1 小时 TTL）；
2. 每次 `tools/call` 带上缓存的 session；
3. 响应里出现 `No valid session ID` 就删缓存、重新握手、重试一次。

### 踩到的两个真坑

写脚本过程中修了两个 bug，都值得记下来。

**坑一：`${2:-{}}` 的默认值展开 bug。**

最初参数默认值写的是：

```bash
ARGS="${2:-{}}"
```

结果传入 `'{"type":1}'` 时，脚本拿到的是 `'{"type":1}}'`——**多了个右花括号**。原因：`${2:-{}}` 里的第二个 `}` 被 shell 当成参数展开的结束符，默认值变成了 `{}` + 字面 `}`。

修复：默认值用单独赋值，不再依赖花括号作为展开默认值：

```bash
ARGS="${2:-}"
if [[ -z "$ARGS" ]]; then
  ARGS='{}'
fi
```

**坑二：函数返回值用 echo 拼两行，被拆错。**

Mock 脚本里 `call()` 函数用 `echo "$code" "$tmp"` 返回状态码和临时文件路径，调用方用 `head -1` / `tail -1` 拆。结果两行拼成了一行，`grep` 把整行当成文件名：

```
grep: 200 /var/folders/.../tmp.xxx: No such file or directory
```

修复：改用全局变量传递返回值，函数只负责执行：

```bash
call() {
  ...
  CALL_CODE="$code"
  CALL_TMP="$tmp"
}
call "$SESSION"
CODE="$CALL_CODE"
```

---

## 五、效果

改完后的数字：

| 项                          | 之前                     | 之后                         |
| --------------------------- | ------------------------ | ---------------------------- |
| 常驻工具数                  | 37（Cooper 31 + mock 6） | 0                            |
| 每轮 system prompt 工具定义 | ≈ 6,453 tokens           | 2 条 skill 索引 ≈ 342 tokens |
| **每轮净节省**              | —                        | **≈ 6,111 tokens**           |
| 启动连接                    | 3 个 server 全连         | 1 个（sequential-thinking）  |

按 `ASCII/4 + CJK/1.5` 的估算口径（也是 `/context` 命令展示的同一算法），一次 20 轮的会话大约省 **12 万 tokens**；用真实 provider tokenizer 计数会有 ±10~20% 偏差，但量级是可靠的。

SKILL.md 正文（Cooper 约 4.7K 字符、mock 约 4.4K 字符）**不在常驻预算里**——只在模型通过 `Skill` 工具触发时按需加载，用完即弃，这就是渐进披露的收益。

还有个之前没意识到的附带好处：**工具选择空间变小了**。模型现在面对的是干净的默认工具集 + 可发现的 Skill 索引；真需要 Cooper 时索引会引导它，而不是在 50+ 个候选里大海捞针。

---

## 六、什么时候不该这么做

这个方案不是免费的，得说清楚代价：

1. **触发依赖描述质量**。Skill 变成常驻索引里的两行字，模型得靠 description 判断"这次要不要读"。description 写不好，工具就"失联"了。我的两个 description 都写了中英双语关键词，尽量覆盖各种问法。
2. **丢失了原生工具体验**。MCP 工具在 agent 眼里是结构化工具，有 schema 校验、有参数提示；Shell 脚本是自由文本，参数错误只能靠脚本自己报。mock 的 `upsert_mock_interface` 参数很多，写 JSON 时更容易出错。
3. **多了一层维护面**。MCP server 更新工具清单后，SKILL.md 和脚本不会自动同步。需要定期重跑 `tools/list` 核对。

所以我的判断标准是：**高频、结构化交互 → 留在 MCP 常驻；低频、能力边界清晰 → 封装成 Skill。** Cooper 和 mock 属于后者——它们功能独立（文档协作 / 接口 mock）、使用频率低、且每个都是完整的一类任务，完美匹配 Skill 的"专家工作手册"定位。

而 `sequential-thinking` 留在了 MCP 常驻：它只有 1 个工具，定义极短，又是通用推理辅助，几乎每轮都可能用。37 个换 1 个，这个置换是划算的。

---

## 七、小结

这次改动的核心不是"省了 6,111 tokens"，而是验证了一个架构观点：

**MCP 是连接层，Skill 是装载层。一个外部服务可以同时是 MCP server（协议）和一个 Skill（入口）。** 把不常用的 MCP server 从启动链路挪到 Skill 里，等于把"通电待机的打印机"变成了"放进柜子里、要用再拿出来"。

对 mica-code 这个项目来说，这也是一次真实的分层实践：协议（MCP）和策略（什么时候加载）彻底分离，产品代码一行没改——改动全部发生在用户侧配置和 Skill 目录里。

如果你也有 MCP server 常年躺在配置里吃灰，不妨先量一量它的工具定义占了每轮多少个 token，再决定是加开关、还是干脆变成 Skill。

---

## 附录：脚本核心片段

`cooper.sh` 的调用与解析（无 session 版本）：

```bash
BODY=$(printf '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"%s","arguments":%s}}' "$TOOL" "$ARGS")
HTTP_CODE=$(curl -sS -m 60 -o "$TMP" -w "%{http_code}" \
  -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: $AUTH" \
  -d "$BODY" || true)

# 解析 SSE：逐行找 data: {json}，找不到再按纯 JSON 兜底
python3 - "$TMP" <<'PY'
import json, sys
raw = open(sys.argv[1], encoding="utf-8", errors="replace").read()
payload = None
for line in raw.splitlines():
    if line.startswith("data: "):
        try:
            payload = json.loads(line[6:])
        except json.JSONDecodeError:
            continue
if payload is None:
    payload = json.loads(raw)
result = payload.get("result") or {}
for c in result.get("content", []):
    if c.get("type") == "text":
        sys.stdout.write(c.get("text", "") + "\n")
PY
```

`mock.sh` 的 session 生命周期：

```bash
# 缓存不存在或超时 → 重新 initialize 拿 Mcp-Session-Id
SESSION=$(get_session)   # curl -D headers，grep -i '^mcp-session-id:'
printf '%s %s' "$(date +%s)" "$SESSION" > "$SESSION_FILE"

# tools/call 带 session 头；遇 "No valid session ID" 则刷新 session 重试一次
if grep -qi "No valid session ID" "$TMPFILE"; then
  rm -f "$SESSION_FILE"
  SESSION=$(get_session)
  call "$SESSION"
fi
```
