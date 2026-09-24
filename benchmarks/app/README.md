# app — 运行 benchmark 的核心代码

```
app/
  console/        Web 控制台：跑 / 停 / 配 API / 看结果矩阵，全在浏览器里
    server/       零依赖 Python HTTP 后端（状态、启动、结果、设置）
    web/          Vite + React + TS 前端
    settings.json 运行配置（含密钥，chmod 600，不入 git）
    routes.json   每个 agent 的上游路由，proxy 热加载
    tools/        browse.py / shot.py：真浏览器验证辅助
                  preflight_proxy.py：开跑前验证鉴权 / 路由 / 计费
  proxy.py        记录代理：所有 agent 的请求都过它，token / 轮次只认它的账
  runner/
    run-agent.sh  单格命令行入口（<agent> <task-id>）
  agents/         各 benchmark harness 的适配器
    mica_code.py  Harbor 的 Mica Code 适配器
    smoke-task/ quick-task/  该适配器的冒烟任务
  env.sh          由控制台生成的 shell 变量（含密钥，chmod 600，不入 git）
  artifacts/      构建产物：mica-agent.tar.gz、跨架构 mica 二进制（不入 git）
  legacy/         已归档的旧脚本（被 console 取代），保留作参考
```

## 三条链路

**1. 控制台**（`console/`）。唯一入口，`python3 -m server.main --port 8790`。后端零依赖，前端产物在 `web/dist/`（先 `npm install && npm run build`）。它自己不跑任务，而是拼出 `harbor run` 命令交给 `runner/`。

**2. 记录代理**（`proxy.py`）。监听 `:8899`，把 `/agent_bench/<agent>/task=<task-id>/...` 映射到上游，每条请求记一行 JSONL。**容器从 `host.docker.internal:8899` 访问它**，所以每个 agent、每个任务的上游请求都能被无歧义地归属——token 与轮次只认这份账，不认 agent 自报。

上游按 agent 路由（`console/routes.json`，mtime 热加载）：`claude-code` 走 `/anthropic`，其余走 DeepSeek 的 OpenAI 兼容端点。两种协议的 usage 字段语义不同（Anthropic 的 `input_tokens` 不含缓存，OpenAI 的含），proxy 统一成 OpenAI 口径后再记录。

**3. 单格执行**（`runner/run-agent.sh`）。`run-agent.sh <agent> <task-id>`，job 目录先清空，所以每个 `(agent, task)` 格子都能按 id 单独重跑。命令行入口与控制台走同一套路径常量。

## 路径只有一个定义

目录布局的唯一定义在 `console/server/settings.py`：

```python
CONSOLE_DIR = <root>/app/console
APP_DIR     = <root>/app
BENCH_DIR   = <root>                     # benchmarks/
PERSISTENCE_DIR = BENCH_DIR / "persistence"
TASKS_ROOT  = BENCH_DIR / "terminal-bench" / "tasks"
```

其余模块（`catalog.py` / `engine.py` / `results.py` / `main.py` / `harbor.py`）全部从它 import。`run-agent.sh` 则从脚本自身位置反推 repo 根，并优先读 `env.sh` 导出的 `MICA_BENCH_{TASKS,JOBS_DIR,TARBALL}`。**新增路径不要各处硬编码。**

## 密钥

`console/settings.json` 与 `env.sh` 含 API key，两者都在 `benchmarks/.gitignore` 里。`settings.py` 的 `redact()` 会在写日志与 `/api/log` 出口把 key 换成 `***`，所以 `persistence/runs/*/*.log` 里也不会有明文 key。改动日志路径或新增落盘点时，保持经过 `redact()`。

## 适配器

`agents/mica_code.py` 的说明见 [`agents/README.md`](agents/README.md)。它是 Harbor 的 `BaseInstalledAgent` 子类，靠 `mica exec` 的 codex CLI 兼容层工作，导入路径是 `benchmarks.app.agents.mica_code:MicaCode`（repo 根需在 `PYTHONPATH` 上）。
