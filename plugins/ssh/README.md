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

- 口令存 macOS 钥匙串（`security add-generic-password`，经 stdin 写入，不进 argv），不写清单文件。
- 主机指纹记在自己的 `known_hosts`（`StrictHostKeyChecking=yes`），首次连接记录、之后严格校验；变了就连接失败，面板上有「重新信任主机密钥」。
- 模型能表达的最大范围是 `{ host: '<别名>', script }`：不能指定别的地址、拿不到口令、改不了校验策略。
- 只读主机（面板里没开写）只能被 `ssh_read` 使用；`ssh_read` 也会拒掉明显的写命令（`rm -rf`、`mkfs`、`systemctl stop`…），因为它们可能被并发或重试执行。
- 每次调用记一行 `audit.jsonl`（时间、主机、退出码、脚本首行），面板「最近操作」可见。

## 文件

```
$MICA_HOME/plugin-data/ssh/
  data.json     主机清单（面板与工具共用，跨进程锁 + 原子写）
  known_hosts   固定的主机指纹
  audit.jsonl   调用记录
  panel.json    面板草稿（正在编辑谁、上次测试结果）
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

- 输入框上方的胶囊「SSH 服务器」→ 面板（`display: 'modal'`）：加机器、测试连接、改认证方式、删机器、看最近调用。
- 模型：`ssh_*` 工具；主机清单同时以一段 prompt 注入每轮请求，模型不必先花一次往返「查有哪些机器」。

清单声明了 `requires: ["desktop"]`（面板要有地方画），所以 TUI 与 `mica exec` 里整个插件会被跳过——
那两种宿主没有桌面端，也就没有配置面板可填口令。桌面端（含它起的 app-server）不受影响。

## 限制

- 只跑非交互命令：`ssh -T`，没有远端 PTY，`top`/`vim` 这类全屏界面不适用。
- 远端窗口宽度固定（120 列），进度条类输出会被 `TERM=dumb` 压成纯文本。
- Windows 远端：`bash -l -s` 要求远端有 bash；没有 bash 的机器需要在脚本里自己换 shell。
