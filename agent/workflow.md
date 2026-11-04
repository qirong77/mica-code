# 默认开发流程（隔离副本）

**所有代码改动都走这条流程。** 目的有三个：不动用户正在用的工作区、允许同一台机器上多个会话同时开发、验证完有一条确定的路径回到 main 并让运行中的实例真的热更新。

一句话版本：**临时目录 clone → 按任务命名的分支 → 开发验证 → 分支推到远端 → 合并进 main 并推送（且校验） → 主工作区拉到合并后的 main → 在用户那份 checkout 重新构建 → 确认产物 fingerprint 等于合并后的 commit → 汇报热更新状态。**

后面四步是硬闸门，**一步都不许静默跳过**：分支必须在远端、main 必须真被合并并推送、主工作区必须真拉到那份合并、构建必须出自主工作区。任何一步做不到，就把卡在哪、用户执行哪条命令能补齐写进回复（第 7 步的格式），而不是悄悄只做前半段。

## 0. 开工（一次）

**取会话 id。** 形状是 `20261104T065949Z-4iqbqr`（UTC 时间戳 + 随机后缀）。当前会话的 id 就在自己的会话文件上：`session_peers` 返回的缓存文件路径 `<id>.json` 去掉扩展名即是。拿不到时自己拼一个：`date -u +%Y%m%dT%H%M%SZ` 加 6 位小写随机后缀。

**命名要能看出在改什么。** 从任务里取 2–4 个英文小写单词当 slug（`plugin-cache-fix`、`schedule-drag-row`），连字符连接；不要用 `fix` / `update` / `wip` / 时间戳这类看不出内容的词。再拼上会话 id 尾部的随机段做唯一后缀（拿不到时 `date +%s | shasum | cut -c1-4`）。**分支 `agent/<slug>-<后缀>`，工作副本目录 `mica_<slug>-<后缀>`**（在 `os.tmpdir()` 下，macOS 形如 `/var/folders/…/T`）。

克隆与装依赖：

```bash
SRC="<主工作区绝对路径>"
ID="<会话 id>"
TAG="<slug>-<id 尾部随机段>"
WORK="$(node -e 'process.stdout.write(require("os").tmpdir())')/mica_$TAG"
git clone --quiet "$SRC" "$WORK"
cd "$WORK"
# 分支必须从 main 起，不能从主工作区当前检出的分支起——否则会把别人未发布的提交带进合并
git checkout --quiet -B "agent/$TAG" origin/main    # 无 origin 时先 `git checkout --quiet main`
bun install
```

- **一切都准备好了再报坐标。** 第一条回复只说这一步要做什么（「先把现有主题链路读准，再开副本」），**不要写路径与分支**：那时副本还没建，用户点开会报「打开路径失败：路径不存在」。上面三条命令都成功后，再单独发一行，发之前 `test -d "$WORK"` 确认目录真的在：

```
工作副本 <临时目录>/mica_<slug>-<后缀> · 分支 agent/<slug>-<后缀> · 会话 <id>
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

## 3. 提交并推送分支（闸门 1）

在副本里做完，**分支必须先到远端**，后面合并才有据可查：

```bash
cd "$WORK"
git status --short                       # 只提交本次任务的文件；格式化、临时脚本不要混进去
git add -A
git commit -m "<一句话说明这个改动>"
git push -u origin "agent/$TAG"
git ls-remote origin "refs/heads/agent/$TAG"   # 必须输出一行，sha 等于本地 HEAD
```

- push 被拒（远端有别人的新提交）：`git pull --rebase origin main` 后重推，最多两次。仍失败就**停在这里**，把远端状态与失败原因写进回复；下面几步都以「分支已在远端」为前提，不要带着没推上去的分支继续合并。
- 没有 origin（纯本地仓库）：跳过 push，在回复里注明「纯本地仓库，分支只在副本里」。
- 收尾是否删远端分支见第 8 步，默认保留。

## 4. 合并进 main 并推送（闸门 2）

```bash
cd "$WORK"
git fetch --quiet origin
git checkout main
git merge --ff-only origin/main                    # 先让自己的 main 跟上远端
git merge --no-ff "agent/$TAG" -m "merge: <同一句话>"
git push origin main
git fetch --quiet origin
git merge-base --is-ancestor "$(git rev-parse "agent/$TAG")" origin/main && echo merged
```

- 最后那条校验必须打印 `merged`。**不要凭「我 push 过了」当结论**：push 失败、推到别处、或忘了切 main 都会让这一步名存实亡。
- push main 被拒（远端有别人的新提交）：`git fetch --quiet origin && git merge origin/main`（已经是 merge 提交了，别再 rebase），再推一次；解不了冲突就停住，把分支与 main 的当前 sha 一起告诉用户，别声称已合并。仍然**不强推**。
- `--no-ff` 合并冲突原则上不该出现（分支从 `origin/main` 起、只改自己那几个文件）。真冲突就先解，解不了就把分支留在远端并说明「未合并」。
- 没有 origin 的纯本地仓库：在副本里切 main 合并，然后主工作区 `git -C "$SRC" fetch "$WORK" main:main`（main 未被 checkout 时可行），否则提醒用户手动合并。
- **不碰用户工作区**：主工作区只做第 5 步的 `--ff-only` 快进，commit / merge 提交 / 开分支都只发生在副本里。

## 5. 让主工作区拿到合并后的 main（闸门 3）

产物写在哪份 checkout，实例就从哪份加载——用户跑的是主工作区的 `apps/desktop/dist/mac-*/mica-code-app.app`，所以主工作区必须先有合并后的代码，第 6 步的构建才有意义。

```bash
cd "$SRC"
git status --short                  # 先看，只读
git fetch --quiet origin
```

按当前状态选动作：

| 主工作区状态                              | 做法                                                                                                                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 在 main、工作区干净                       | `git pull --ff-only`                                                                                                            |
| 在 main、有未提交改动                     | 直接 `git pull --ff-only`：git 只写被合并到的文件，改动文件与本次合并不重叠时能成功；被拒就按下面「快进失败」处理，**不 stash** |
| 在别的分支，且该分支是 `origin/main` 祖先 | `git merge --ff-only origin/main`（等于原地快进，不换分支、不留 merge 提交）                                                    |
| 在别的分支，且有自己的提交                | 不动它（那多半是用户自己正在做的需求）                                                                                          |

校验（`src-up-to-date` 一定要打印出来）：

```bash
git -C "$SRC" merge-base --is-ancestor origin/main HEAD && echo src-up-to-date
```

- **绝不** `git stash` / `git reset --hard` / `git checkout --` / `git checkout main` —— 那是替用户丢改动或换分支。
- **快进失败**（校验没打印、pull 被拒、或主工作区在带自己提交的分支上）就是这条流程今天的天花板：第 6 步改为在副本里只做 CLI 那一档 `bun run build`，并按第 7 步写明「桌面产物未重建 + 原因 + 用户要执行的确切命令」。**不许**在主工作区的旧代码上构建再声称已热更新。

## 6. 在主工作区重建并热更新（闸门 4）

在第 5 步校验通过的前提下，按改动面选命令，**在 `$SRC` 里执行**：

| 改了什么                                               | 命令（工作目录 `$SRC`）                                               | 热更新层级                                          |
| ------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------------------- |
| `apps/desktop`（renderer / runtime / shell）、外壳配置 | `npm run build:app`                                                   | 产物指纹决定：只刷页面 / 换会话宿主 / 整窗 relaunch |
| `apps/cli` / `packages` / `plugins`（CLI、插件、工具） | `bun run build`，再 `cd apps/desktop && node scripts/build-stamp.mjs` | 换掉会话宿主再刷页面                                |
| 只有文档 / `agent/**` / `AGENT.md`                     | 不用构建                                                              | —                                                   |

- `npm run build:app`（= `apps/desktop` 的 `build:unpack`）三份构建 + `electron-builder --dir` + 写产物指纹一把做完，桌面端与 CLI 一起覆盖；只改了 CLI / 包时走轻的那一档，省掉打包的十几秒。
- 构建是唯一的共享点（`~/.local/lib/mica/mica` 与 `.app` 会被覆盖）。多个会话同时构建先争锁：

```bash
LOCK="$HOME/.mica/.build-lock"
until mkdir "$LOCK" 2>/dev/null; do sleep 2; done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
```

- **构建完必须校验指纹里的 revision 就是合并后的 main**，否则等于拿旧代码热更新：

```bash
node -e 'const s=require(process.env.HOME+"/.mica/dev-build-stamp.json");console.log(s.builtAt, s.revision)'
git -C "$SRC" rev-parse --short HEAD
```

两条的 revision 要一致。不一致 → 回到第 5 步的「快进失败」，别写「已热更新」。

- 再看有没有实例在跑，决定这次是真的热更新还是「下次启动生效」（`pgrep -f` 在 macOS 上看不到 Electron 主进程，用 `ps`）：

```bash
ps -eo command | grep -F "MacOS/mica-code-app" | grep -v -- "--type=" | grep -q . && echo instance-running || echo no-instance
```

- 实例按指纹自我重载（判层与节奏见 `desktop.md` 的「构建后自我重载」，`MICA_DEV_RELOAD=0` 会关掉）；正在跑的一轮走「软停 + 自动续跑」，不要因为怕打断用户就不构建。
- 副本里构建出来的 `.app` 不在运行实例的位置，**只有 CLI 例外**（装在 `~/.local/lib/mica`，哪份 checkout 构建都生效）。

## 7. 汇报（两行，第二行不许省）

- 代码行：`工作副本 <临时目录>/mica_<slug>-<后缀> · 分支 agent/<slug>-<后缀>（已推送 <短 sha>）· 合并 commit <merge 短 sha>（已在 origin/main）`
- 热更新行，二选一，说清事实：
  - `已热更新 · <层：页面 / 会话宿主 / 整窗重启> · 产物 revision <短 sha> = 合并后的 main · 正在跑的实例停在轮次边界后续跑`
  - `未热更新 · 原因 <主工作区在 <分支> / 有未提交改动 / push 失败 / 构建失败> · 你需要执行 <确切命令>，之后我再构建`

补一句第 5 步的结论：主工作区已包含 `origin/main` 就不用提；没包含就写 `origin/main 已到 <短 sha>，你当前的 <分支> 还没合并`（仍**不要替用户合并**带自己提交的分支）。

## 8. 收尾

- 回复里给全：分支名、合并的 commit、临时目录路径、热更新那一行的结论。
- 临时目录默认**保留**（用户可能要复现或回看），删除要先确认；确认后 `rm -rf "$WORK"`，并顺手删远端分支 `git push origin --delete "agent/$TAG"`（用户同意才删）。
- 交付前 `git status --short` 看一眼主工作区，确认没留下自己的临时文件。

## 例外

- 只读排查（一行都不改）不需要副本。
- 不产生运行时代码差异的改动——纯文档、`agent/**`、`AGENT.md`、README / 站点文案——直接在主工作区改，不 commit、不 push，也不必构建。
- 用户明确说「就在主工作区改」时按用户要求，并在回复里提醒：本次没有副本、没有分支、没有合并，也不会热更新。
- 有未提交改动的临时验证（`.probe-*.mjs`）用完就删，不要带进合并。
- 别的业务仓库按那个仓库自己的约定，本文只覆盖 mica-code 本体。
