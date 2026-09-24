# benchmarks

用同一个模型横向对比不同 coding agent harness（只换 harness，不换模型）的基准测试工作区。

```
benchmarks/
  app/               运行 benchmark 的核心代码
  persistence/       运行记录
  terminal-bench/    一个 benchmark：它的任务包
  RUNBOOK.md         完整操作手册（怎么搭、怎么跑、怎么读结果）
```

三块的边界：

| 目录 | 是什么 | 进 git 吗 |
|---|---|---|
| `app/` | 控制台（Web UI）、记录代理、runner 脚本、各 harness 的 Harbor 适配器 | **是**（代码 + 文档） |
| `persistence/` | 每次 sweep 的判决、结果表、Harbor 原始产物 | 否，整块忽略（只留目录说明 `README.md`） |
| `terminal-bench/` | Terminal-Bench 的任务包（66 个任务） | 任务包是下载的，忽略；本目录说明跟踪 |

判断规则：**git 只跟踪代码与说明文档；`persistence/` 里跑出来的数据（判决表、结果表、Harbor 产物、代理流水）整块不入库**。要长期留存的结论写进 `RUNBOOK.md`。所以 clone 下来能读、能跑，但不会背着一个 G 的记录。

## 快速上手

```sh
# 1. 控制台（Web UI + 结果矩阵 + 运行控制）
cd benchmarks/app/console
python3 -m server.main --port 8790          # http://127.0.0.1:8790

# 2. 记录代理：所有 agent 的上游请求都经过它，token / 轮次只认它的账
#    （控制台会自动拉起，一般不用手动起）
python3 benchmarks/app/proxy.py

# 3. 命令行跑单格
source benchmarks/app/env.sh                 # 由控制台生成，含密钥（chmod 600，不入 git）
benchmarks/app/runner/run-agent.sh mica session-window-debug
```

任务包不在 git 里，先按 `RUNBOOK.md` 下载到 `terminal-bench/tasks/`。

## 读结果

- 控制台的矩阵：**行 = agent，列 = 勾选的任务，每格 = 该 agent 在该任务上的一次运行**。
- 命令行：`persistence/runs/<tag>/status.tsv` 是每格的判决表。
- 历史对比表：`persistence/results-*.txt`。

细节、坑、以及「为什么 codex / claude-code 的 setup 这么慢」都在 [`RUNBOOK.md`](RUNBOOK.md)。
