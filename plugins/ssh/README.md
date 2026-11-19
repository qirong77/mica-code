# ssh

让模型操作**远端**服务器。走系统 OpenSSH（`/usr/bin/ssh`），不是自实现的 SSH 协议——`~/.ssh/config`、私钥、ssh-agent、ProxyJump、2FA、known_hosts 全部沿用用户已有的那套。

## 为什么不是「自建 HTTP shell」

浏览器里那个 `http://host:9100/` 的问题不是慢，是**端口对着公网就等同于把 root shell 挂上去**。这里的暴露面反过来：目标机不开任何端口，本机出站连 22。

## 模型侧只有四个工具

| 工具 | 用途 | 并发 |
| --- | --- | --- |
| `ssh_read` | 只读查询；`hosts: [...]` 一次往返查多台 | `readOnly: true`，与同消息里其它只读调用并发 |
| `ssh_run` | 一段多行 bash 脚本，等它结束返回退出码与输出 | 串行屏障 |
| `ssh_session` | 持久 shell：`open` / `run` / `write` / `wait` / `read` / `close` | 串行屏障 |
| `ssh_hosts` | 增删改查主机清单（口令不支持经模型，见下） | 串行屏障 |

**效率的全部要点在「一次调用 = 一轮完整模型请求」**：

1. 工具描述要求把排查/变更的几步写进同一个脚本，而不是一条命令一次调用（数量级差别）。
2. `ssh_read` 标 `readOnly: true`，多台机器并发；跨机器排查只花一次往返。
3. ControlMaster 复用连接（`/tmp/mica-ssh-<uid>/%C`，默认空闲 600s），单次调用的 ssh 握手成本≈0。
4. 输出默认只回最后 300 行，全文在远端 `/tmp/mica-ssh-*.log`，模型需要细节时再 `grep`。不裁的代价不是一次调用大，而是之后**每一轮**都要重发这段历史。
5. 长任务走 `ssh_session`：连接常驻、`cd`/虚拟环境状态保留，工具超时不再是问题。

## 安全

- 口令存本插件 `secrets.json`（本机明文、0600，不进系统钥匙串），不写主机清单、不进对话；连接时由临时 askpass 文件交给 OpenSSH。
- 主机指纹记在自己的 `known_hosts`，首次连接记录，已固定指纹的主机使用 `StrictHostKeyChecking=yes` 严格校验；变了就连接失败。
- 模型能表达的最大范围是 `{ host: '<别名>', script }`：不能指定别的地址、拿不到口令、改不了校验策略。
- 标为只读的主机只能被 `ssh_read` 使用，不能通过 `ssh_session open/run/write` 开交互 shell 绕过。`ssh_read` 会拒掉明显的写命令（`rm -rf`、`mkfs`、`systemctl stop`…），但这不是脚本沙箱，真正的远端只读权限仍需服务器账号限制。
- 持久 shell 的 `open/run/write` 每次重新核对主机、当前会话范围与只读标记，实际写入 stdin 前再检查；目标、认证或指纹变化也使旧 shell 失效。`read/wait` 只观察既有输出，不发送命令，但仍需同样的有效授权；`list` 清理并隐藏失效 shell。失效时本地连接关闭，`close` 始终允许，包括配置读失败或授权已撤销时。面板移除会话范围会立即关闭本地 shell；不能据此保证已在远端脱离 shell 的任务终止。
- 每次调用记一行 `schemaVersion: 2` 的私有 `audit.jsonl`（0600：时间、主机、退出码、**首个物理行的 SHA-256**），不保存命令正文、参数、后续行或原始错误备注，只保留白名单固定备注码或 `diagnostic_omitted`。合法当前记录只保留最近 200 条，并非完整历史。运行期读取只认 v2、`sha256:<64hex>` 和固定备注码；**旧形态不再支持**，由 Evolution 的 `ssh-audit-v2` 将完整原文 0600 归档到 `plugin-data/evolution/legacy-ssh-audit/` 后转换，事件时间与退出码不补造。损坏 / 超限历史或未知版本不部分改写；读取不会改写文件，维护也不把旧原文悄悄丢掉。
- 迁移、追加与原子维护共用同步跨进程 `audit.lock`；忙锁本轮不写，和其它写入/维护失败一样仅累计进程内 `auditFailureCount()` 并记录固定日志 `ssh.audit_write_failed`，不改变远程操作结果。审计是尽力记录，不是持久投递保证。未达保留上限时，文件身份未变的本进程追加复用行数缓存；外部写入 / 替换立即失效。持久会话的 run/write 在命令完成时记一次，等待超时不是完成，重复 wait 不重复记账。
- 主机清单只有 `ENOENT`（文件不存在）可以空初始化；损坏 JSON、非法结构、重复别名、权限与 IO 失败都会阻断 mutation，保留原字节。跨进程锁和临时文件原子替换不变。

## 文件

```
$MICA_HOME/plugin-data/ssh/
  data.json     主机清单（面板与工具共用，跨进程锁 + 原子写）
  known_hosts   固定的主机指纹
  audit.jsonl   调用记录
  panel.json    面板草稿（正在编辑谁、上次测试结果）
  secrets.json  本机 0600 明文口令
```

`data.json` 形状：

```json
{
  "version": 1,
  "hosts": [
    {
      "id": "test",
      "host": "10.0.0.1",
      "port": 22,
      "user": "root",
      "auth": "password",
      "label": "测试机",
      "readOnly": false,
      "fingerprint": "SHA256:..."
    }
  ]
}
```

## 入口

- 输入框上方的胶囊「SSH 服务器」→ 面板（`display: 'modal'`）：加机器、测试连接、改认证方式、删机器、调整会话范围。连接/保存失败返回结构化 `outcome/code` 并保留现有消息与表单；删除确认、取消、授权拒绝与成功分开表达。
- 模型：`ssh_*` 工具；`ssh` 提示词段落只注入本次会话的主机清单，或无配置 / 未添加到会话时的面板指引，模型不必先花一次往返「查有哪些机器」。多行脚本、并发、超时与日志输出的用法统一在工具描述中；段落的已有开关与自定义正文继续生效。

清单声明了 `requires: ["desktop"]`（面板要有地方画），所以 TUI 与 `mica exec` 里整个插件会被跳过——
那两种宿主没有桌面端，也就没有配置面板可填口令。桌面端（含它起的 app-server）不受影响。

## 限制

- 一次性命令使用 `ssh -T`；持久 shell 使用远端 PTY 并关闭回显与换行转换。`top`/`vim` 这类全屏界面不适用。
- 持久 shell 的远端窗口宽度固定（200 列），进度条类输出会被 `TERM=dumb` 压成纯文本。
- Windows 远端：`bash -l -s` 要求远端有 bash；没有 bash 的机器需要在脚本里自己换 shell。

工具返回仍是字符串，内容为 JSON（`outcome`、固定 `code`、可选 `error/exitCode/timedOut` 与人类可读 `text`）；取消、拒绝、等待、忙、冲突和失败分别表达，成功也保留正文。

口令存储也采用严格读改写：只有 ENOENT 是首次使用，损坏 JSON、非法结构、权限或 IO 错误拒绝覆盖并保留原字节。口令增删在同一跨进程锁内读取最新基线，0600 原子替换；忙锁显式返回忙，不覆盖其它主机的口令。
