# persistence — 运行记录

每次 sweep 的可复核记录。**整个目录不入 git**（`benchmarks/.gitignore` 里 `persistence/*`，只放行本文件）：判决表、结果表、Harbor 产物、代理流水都是重跑即再生的数据，塞进 git 只会让仓库无限膨胀。要长期留存的结论请写进 `../RUNBOOK.md`。

## 目录

```
persistence/
  runs/<tag>/status.tsv      ★ 每格判决表（rc / reward / wall）
  runs/<tag>/*.log           单格原始 stdout
  runs/<tag>/REPORT.md       机器生成的汇总表
  runs/reg2/FINAL_SUMMARY.txt
  results-*.txt              历史对比结果表
  events.jsonl               代理请求流水（MB 级）
  harbor-jobs/<tag>__<agent>__<task>/
                              Harbor 每格原始产物：attempt 目录、trajectory、
                              verifier/ctrf.json、agent 日志
  experiments/               早期 ablation 记录与当时的 mica HOME 快照
```

## 一个 cell 里有什么

`harbor-jobs/<tag>__<agent>__<task>/<task>__<hash>/`：

| 路径 | 内容 |
|---|---|
| `result.json` | Harbor 的判决（`started_at`、reward） |
| `agent/` | agent 输出（`mica.txt` / `codex.txt` / `claude-code.txt`）、`trajectory.json` |
| `verifier/reward.txt` | 二值判决 |
| `verifier/ctrf.json` | 逐条测试明细（**只有 pytest 型 verifier 有**） |
| `verifier/test-stdout.txt` | verifier 原始输出 |
| `artifacts/` | 任务声明的产物快照 |
| `trial.log` | 依次执行的命令序列（含 agent 的 install 命令） |

判定「这一格跑完了」看 `result.json` 是否存在——verifier 中途被杀时 reward 文件可能已写但判决无效。

`ctrf.json` 的 `tests[]` 是 pass/fail 明细的唯一来源；shell 型 verifier 没有它，只能退化成二值。控制台的抽屉按它渲染失败优先的明细列表。

## 怎么读

```sh
sort -k1,1 -k2,2 persistence/runs/<tag>/status.tsv     # rc / reward / wall 一屏看完
```

跨 agent 的均值只有在**每格覆盖齐全**时才有意义：各 agent 跑的任务集不完全一致时，均值比较不成立（见 `RUNBOOK.md`）。
