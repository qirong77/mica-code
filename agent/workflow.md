# 默认开发流程（隔离副本）

**所有功能开发都走这条流程。** 目的有三个：不动用户正在用的工作区、允许同一台机器上多个会话同时开发、验证完有一条确定的路径回到 main 并让运行中的实例热更新。

一句话版本：**临时目录 clone → 会话 id 命名的分支 → 开发验证 → 合并 main → 在主工作区构建触发热更新 → 提醒用户当前分支没合并。**

## 0. 开工（一次）

**取会话 id。** 形状是 `20261104T065949Z-4iqbqr`（UTC 时间戳 + 随机后缀）。当前会话的 id 就在自己的会话文件上：`session_peers` 返回的缓存文件路径 `<id>.json` 去掉扩展名即是。拿不到时自己拼一个：`date -u +%Y%m%dT%H%M%SZ` 加 6 位小写随机后缀。

**命名。** 工作副本在系统的临时目录下（`os.tmpdir()`，macOS 形如 `/var/folders/…/T`），目录名 `mica_<会话 id>`；分支名 `agent/<会话 id>`。两者都带 id，事后能对上号。

**开工的第一条回复里必须写出来**，让会话里看得见：

```
工作副本 <临时目录>/mica_<id> · 分支 agent/<id> · 会话 <id>
```

克隆与装依赖：

```bash
SRC="<主工作区绝对路径>"
ID="<会话 id>"
WORK="$(node -e 'process.stdout.write(require("os").tmpdir())')/mica_$ID"
git clone --quiet "$SRC" "$WORK"
cd "$WORK"
# 分支必须从 main 起，不能从主工作区当前检出的分支起——否则会把别人未发布的提交带进合并
git checkout --quiet -B "agent/$ID" origin/main     # 无 origin 时先 `git checkout --quiet main`
bun install
```

- 本地 clone 走硬链接，通常几秒；`bun install` 只装根 workspaces（`packages/*`）。
- **分支起点是 `origin/main`**：主工作区可能正 checkout 在别人的需求分支上，从它起分支会把那些提交一起带进后面的合并。
- 要跑桌面端再 `cd apps/desktop && npm install`（它有自己的 node_modules，也是磁盘大头；只改 CLI / 包时不必装）。
- clone 只拿**已提交**的内容：主工作区的未提交改动不会跟过来（这是有意的隔离）。确实要把它们带进副本时，先 `git -C "$SRC" diff > /tmp/…patch` 再在副本里 apply，并在回复里说明。

## 1. 开发

在副本里改，遵守 `AGENT.md` 的编辑约束（只改任务相关文件、不顺手重构与格式化）。

## 2. 验证

- 跑与改动最接近的单测 + `bun run typecheck`；桌面端按改动侧跑（`bun test src/host` 等）。
- **不跑长验证**：全量 `bun run test`、全量 `npx eslint src/`、`app-server.flows.test.ts` 这类真实子进程 E2E 默认都不跑，除非用户明确要求或要发布。尺度见 `build.md`。
- 复现与手工验证用隔离环境：`MICA_HOME`、`MICA_DESKTOP_USER_DATA`、`MICA_DESKTOP_PORT` 与独立 `--user-data-dir`，不碰 `~/.mica` 里的真实数据。

## 3. 合并到 main

在**副本里**完成，不要拿用户的工作区做实验：

```bash
cd "$WORK"
git add -A
git commit -m "<一句话说明这个改动>"
git push -u origin "agent/$ID"          # 有 origin 时
git checkout main && git pull --ff-only
git merge --no-ff "agent/$ID" -m "merge: <同一句话>"
git push origin main
```

- `git add -A` 之前先看一眼 `git status --short`，只提交本次任务的文件；格式化、临时脚本不要混进去。
- push 被拒（远端有别人的新提交）时**不要强推**：`git pull --rebase` 后重试，冲突解不了就把分支留在远端并告诉用户。
- 没有 origin（纯本地仓库）：在副本里切 main 合并，然后主工作区 `git -C "$SRC" fetch "$WORK" main:main`（main 未被 checkout 时可行），否则提醒用户手动合并。
- **不碰用户工作区**：不在主工作区 commit / merge / 切分支。唯一例外是第 4 步里「主工作区正好在 main 且干净」时的 `pull --ff-only`。合并本身只发生在副本里。

## 4. 热更新用户的运行时

合并之后让运行中的实例用上新代码。按改动面选命令，**在用户实际运行的那份 checkout 里**执行：

| 改了什么                                               | 命令                                                                  | 正在跑的会话                          |
| ------------------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------- |
| `apps/cli` / `packages` / `plugins`（CLI、插件、工具） | `bun run build`，再 `cd apps/desktop && node scripts/build-stamp.mjs` | 停在下一次请求前，重启后自动续跑      |
| `apps/desktop/src/renderer`                            | `cd apps/desktop && npm run build:app`                                | 同上（`.app` 被重写 → 外壳 relaunch） |
| `out/server` / `out/main`（运行时、外壳）              | 同上                                                                  | 同上，页面重连                        |
| 只有文档 / `agent/**` / `AGENT.md`                     | 不用构建                                                              | —                                     |

- **产物写在哪份 checkout，实例就从哪份加载。** 用户跑的是 `apps/desktop/dist/mac-*/mica-code-app.app` 时，页面与运行时都在那个 bundle 里，必须在**主工作区**执行 `npm run build:app`；副本里构建出来的 `.app` 不在运行实例的位置。CLI 例外：它装在 `~/.local/lib/mica`，哪份 checkout 构建都生效。
- 主工作区**正好在 main 且工作区干净**时，先 `git -C "$SRC" pull --ff-only` 把这次合并拉进来再构建——构建必须是合并后的代码，否则等于拿旧代码热更新。
- 主工作区在别的分支、或有未提交改动时：**不拉、不切**，只做 CLI 那一档（副本里 `bun run build`），并提醒用户合并后自己做桌面构建。
- 构建是唯一的共享点（`~/.local/lib/mica/mica` 与 `.app` 会被覆盖）。多个会话同时构建先争锁：

```bash
LOCK="$HOME/.mica/.build-lock"
until mkdir "$LOCK" 2>/dev/null; do sleep 2; done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
```

- 构建收尾写 `$MICA_HOME/dev-build-stamp.json`，运行中的实例据此自我重载（判层与节奏见 `desktop.md` 的「构建后自我重载」）。`MICA_DEV_RELOAD=0` 关掉这套。

## 5. 提醒用户主分支状态

合并后检查用户当前检出有没有包含这次合并：

```bash
git -C "$SRC" fetch --quiet origin
git -C "$SRC" merge-base --is-ancestor origin/main HEAD || echo "needs-merge"
```

- 没包含 → 在回复里明确说一句：`origin/main` 已到 `<短 commit>`，你当前的 `<分支>` 还没合并，需要时 `git merge origin/main`。**不要替用户合并**。
- 已包含 → 不必提。

## 6. 收尾

- 回复里给全：分支名、合并的 commit、临时目录路径、是否已触发热更新、以及第 5 步的结论。
- 临时目录默认**保留**（用户可能要复现或回看），删除要先确认；确认后 `rm -rf "$WORK"`，并顺手删远端分支 `git push origin --delete "agent/$ID"`（用户同意才删）。
- 交付前 `git status --short` 看一眼主工作区，确认没留下自己的临时文件。

## 例外

- 纯文档 / 文案、一行修复、只读排查：直接在主工作区改，不必 clone；仍然不 commit / push。
- 用户明确说「就在主工作区改」时按用户要求，并在回复里提醒当前处在主工作区。
- 有未提交改动的临时验证（`.probe-*.mjs`）用完就删，不要带进合并。
- 别的业务仓库按那个仓库自己的约定，本文只覆盖 mica-code 本体。
