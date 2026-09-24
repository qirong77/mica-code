# mica-file-mentions

`@` 文件补全的唯一实现：CLI 输入框、CLI 的 file-mention 插件和 `apps/desktop` 的聊天输入框都引用它，所以两端的触发规则、候选、顺序、数量和插入文本完全一致。

## 能力

- **触发判定**：`activeFileMention(text, caret)`——`@` 必须在词首（文本开头、空白、开括号/引号，或一个非 ASCII 字符之后），到光标之间没有空白和第二个 `@`。`mail@x.com` 不触发，`参考@src/a.ts` 触发。
- **候选生成**：`findFileMentions(root, query)`（Node）——优先把查询推给 `fd`（存在时），否则用 `git ls-files --cached --others` 列工作区文件并回退到目录遍历；结果按 root 缓存 45s，`prewarmFileMentions(root)` 可以在用户敲 `@` 之前先热一遍。
- **评分排序**：`rankWorkspaceFiles(files, query)`——精确文件名 > 文件名前缀 > 文件名子串 > 路径子串，目录额外 +10 同分时排在文件前；命中查询才出现（不做乱序字母模糊匹配）。只取前 `MAX_FILE_MENTION_RESULTS`（20）条。
- **展示与插入**：`label` 是文件名（目录带尾 `/`），`description` 是工作区相对路径，`labelHighlights` 是 `label` 里命中查询的字符下标；`mentionText(path)` 生成插入文本 `@path `，路径含空白或引号时整条 JSON 化（`@"a b/c.ts" `）。

## 目录

- `rank.ts`：纯逻辑（触发、评分、排序、高亮、插入文本），**无 node 依赖**，浏览器渲染层可直接引用 `@packages/mica-file-mentions/rank.js`。
- `search.ts`：工作区扫描与缓存，只在 Node 侧使用（`apps/cli`、`apps/desktop` 的 host）。
- `index.ts`：导出上面两者。

## 使用入口

```ts
import { activeFileMention, mentionText } from '@packages/mica-file-mentions/rank.js';
import { findFileMentions, prewarmFileMentions } from '@packages/mica-file-mentions/index.js';
```

`packages/mica-ui/input/state.ts` 的 `TerminalFileMentionItem` 就是这个包的 `FileMentionItem`，插件注册的 provider 直接返回它的字段即可。

## 验证

```bash
bun run test -- packages/mica-file-mentions/rank.test.ts packages/mica-file-mentions/search.test.ts
```
