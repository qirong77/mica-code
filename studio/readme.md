# Studio 发布分支

本分支从 `main` 分支切出，用于发布 Studio（内部终端 code agent）。

## 特性

- 打包后会额外生成 `studio` 命令（基于同一份源码，仅注入不同的 app name），不修改原有的 `mica` 命令。
- 发布目标：`@didi/spring-cli`（`>= 1.9.1`），通过 npm 全局安装后自动把平台对应二进制复制到 `~/.local/bin/studio`。
- 发布项目地址：`/Users/qironglin/Desktop/VsGo-Projects/spring-cli/spring-cli`（可用环境变量 `SPRING_CLI_DIR` 覆盖）。

## 一键发布

仓库内已内置发布命令 `release:studio`，自动完成：typecheck → 构建 → 复制二进制 → bump 版本号 → npm publish → 校验发布结果。

```bash
bun run release:studio                  # 默认：patch 版本 +1 并发布
bun run release:studio --minor          # minor 版本 +1
bun run release:studio --major          # major 版本 +1
bun run release:studio --version=1.10.0 # 指定版本号
bun run release:studio --dry-run        # 只预览执行计划，不执行任何命令
bun run release:studio --skip-typecheck # 跳过 typecheck，加快构建
```

> 发布前请确认本仓库处于 `studio` 分支（脚本会自动检查，其他分支会拒绝发布）。

## 文档

- `studio/doc.md`：Studio 使用文档（markdown 版）。
