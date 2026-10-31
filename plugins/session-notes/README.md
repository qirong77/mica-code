# Session Notes

会话笔记：一份用户与模型共享的 markdown 文档，存在会话快照里而不是对话历史里。

- 不会被上下文压缩改写，每轮都会重新附到 system prompt 末尾
- 用户可以在桌面端的笔记面板里编辑，模型用 `session_notes` 工具读写
- 会话结束、fork、resume 都跟着会话走；rewind 随 checkpoint 一起回滚

## 工具

`session_notes` 只有三个动作：

| action    | 作用                                         |
| --------- | -------------------------------------------- |
| `read`    | 读当前内容，空时返回提示而不是空字符串       |
| `append`  | 在末尾追加一段，已有内容保留                 |
| `replace` | 整篇替换，传空字符串清空笔记                 |

工具只改内存，落盘交给本轮的 session checkpoint；不要在工具里自己写盘。

## 文件

| 文件              | 职责                                     |
| ----------------- | ---------------------------------------- |
| `index.ts`        | 注册工具与 prompt 段落                   |
| `NotesTool.ts`    | 工具定义、入参解析、三种动作的实现       |
| `notesSection.ts` | 拼进 system prompt 的那段说明            |
| `NotesTool.test.ts` | 入参与动作的行为测试                   |
