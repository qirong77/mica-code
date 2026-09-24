# terminal-bench

一个 benchmark：Terminal-Bench 的任务包，由 [Harbor](https://github.com/harbor-framework/harbor) 执行。

```
terminal-bench/
  tasks/       66 个任务（下载，不入 git）
  tasks.txt    默认跑的任务子集（手动 run-agent.sh 的兜底选择）
```

## 任务包从哪来

`tasks/` 是从上游下载的 Terminal-Bench 任务包，**不是本仓库编写的**，所以不入 git。首次使用先按 [`../RUNBOOK.md`](../RUNBOOK.md) 的「准备任务包」一节下载到这里。

每个任务一个目录：

```
tasks/<task-id>/
  task.toml       任务规格：镜像、超时、[metadata] category
  instruction.md  给 agent 的题面
  environment/    环境（多数任务带 Dockerfile，但实际用 task.toml 里的预构建镜像）
  tests/          verifier
  solution/       参考解
```

## 66 个任务，7 个分类

分类取自 `task.toml` 的 `[metadata] category`，控制台按它分组（顺序按 `CATEGORY_ORDER`，不按字母）：

| 分类 | 任务数 |
|---|---|
| Software | 18 |
| Science | 14 |
| ML | 11 |
| Operations | 9 |
| Security | 5 |
| Hardware | 5 |
| Media | 4 |

## 判决怎么来的

每个任务的 `tests/` 是一个 shell verifier，写 `/logs/verifier/reward.txt`（0 或 1）。要拿到**逐条测试明细**还需要 verifier 额外产出 `ctrf.json`——本包里 66 个任务的 verifier 都是 pytest 型，所以都有 `tests[]` 明细；控制台抽屉里的失败优先列表读的就是它。

## 模型覆盖上的两个已知缺口

- `cargo-flight-dispatch`、`music-harmony` 至今没有任何 agent 跑过。
- `mvcc-lsm-compaction` 被排除：它的 verifier 要编译并跑一套 C++ 测试，需要 2.5 小时以上。

## 镜像与架构

任务声明的是**预构建的 amd64 镜像**。在 arm64 机器上这意味着容器跑在模拟层里——这既是 setup 慢的主因，也让 `mica` 的 x64 二进制在 qemu 下 SIGILL。处理方式见 [`../RUNBOOK.md`](../RUNBOOK.md) 的「镜像与架构」一节。

镜像是**拉取**而不是本地构建的：`task.toml` 的 `[environment]` 与 `[verifier.environment]` 各带一个 `docker_image = "harborframework/terminal-bench:<task>-…@sha256:…"`，只要这个字段在，Harbor 的 `should_use_prebuilt_docker_image` 就返回 True，旁边那份 Dockerfile 只在 `--force-build` 时用。所以 `task.toml` 是镜像引用的唯一来源；控制台按它逐个任务串行预热（`catalog.task_image_refs` + `engine._warm_task_images`），同一个任务的多个 agent 才不会各拉一遍同一个镜像。
