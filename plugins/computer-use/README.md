# Computer Use

让模型直接操作 macOS 桌面；权限状态显示在配置页这个插件自己的详情里。

## 它由三块组成

| 块 | 位置 | 说明 |
| --- | --- | --- |
| skill | `skill/SKILL.md` | 模型的操作手册。setup 时通过 `ctx.skills.register()` 注册，与用户自己的 skill 同权 |
| runtime | `runtime/scripts/desktop.mjs` + `runtime/src/helper.m` | 零 npm 依赖；AX 元素树与 CGEvent 键鼠都在 ObjC helper 里，首次用到时 clang 编译一次 |
| 运行条件 | `plugin.json` 的 `desktop.checks` | 只声明 id；状态由桌面端探测，显示在配置页的插件详情里，可一键跳到系统设置 |

## 为什么 runtime 要落盘

`mica build` 把官方插件编译进单二进制，运行时没有插件目录可读。而 skill 正文里必须给出
**真实可执行的绝对路径**，helper 也需要稳定的编译产物位置。所以：

1. `scripts/generate-computer-use-sources.mjs` 把 `runtime/**` 内嵌成 `runtimeSources.ts`
   （与 `mica-pty` 的 `ptyServerSource.ts` 同一套做法，`index.test.ts` 断言两者同步）；
2. setup 把内嵌内容写到 `$MICA_HOME/computer-use/`（内容没变就不写——helper 的编译缓存
   按源码 mtime 判断，每次重写会让每次启动都重新编译）；
3. 用落盘路径替换 SKILL.md 里的 `{{RUNTIME_DIR}}`，再注册 skill。

改了 `runtime/` 下任何文件都要重新生成：

```bash
bun run scripts/generate-computer-use-sources.mjs
```

## 为什么它只在桌面端可用

清单声明了 `requires: ["skills", "desktop", ...]`。`desktop` 是 desktop 宿主特有的能力面：
desktop 运行时 spawn `mica app-server` 时注入 `MICA_PLUGIN_DESKTOP_HOST=1`，app-server 才把
`ctx.desktop` 交给插件。CLI / TUI / `mica exec` 里没有这个能力，整插件在注册阶段被跳过
（原因写进 `plugin-status.json`），而不是装载成功却什么都做不了。

## 页面上的三个检查项

`accessibility` / `screen-recording` / `command-line-tools` 来自 `mica-plugin` 的
`DESKTOP_CHECKS` 目录——那是宿主与插件共用的单一事实来源：

- 插件只声明"我需要哪几项"，不描述状态、不拼系统设置 URL；
- 桌面端主进程负责探测（TCC 状态属于有 app 身份的那个进程，运行时进程拿不到）与跳转；
- 新增一项检查 = 在 `DESKTOP_CHECKS` 登记 + 主进程实现探测器，插件侧不用改代码。

## 环境要求

- macOS（其它平台下插件只上报一条 warn，不注册 skill）；
- Xcode Command Line Tools（`xcode-select --install`）：helper 需要 clang 编译一次；
- 辅助功能 + 屏幕录制权限授予 **运行 Mica 桌面端的那个 app**，改完要重启它。

## 命令执行边界

鼠标移动在一次 helper 调用内读取原位置、移动并校验位置，减少两次 native 进程启动。
坐标、持续时间与等待超时在调用 native 工具前校验；组合键的每一段都确认合法后才发出任何键盘事件，空段（如 `cmd++a`）直接报错。

## 验证

```bash
bun run test -- plugins/computer-use
node $MICA_HOME/computer-use/scripts/desktop.mjs check
```
