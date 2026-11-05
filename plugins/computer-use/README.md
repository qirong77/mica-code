# Computer Use

让模型直接操作 macOS 桌面——**动键鼠之前先问过用户**；权限状态显示在配置页这个插件自己的详情里。

## 它由四块组成

| 块 | 位置 | 说明 |
| --- | --- | --- |
| skill | `skill/SKILL.md` | 模型的操作手册。setup 时通过 `ctx.skills.register()` 注册，与用户自己的 skill 同权 |
| tool | `Tool.ts` | `computer_use` 工具：模型动桌面的**唯一入口**。一次调用 = 一批步骤 = 一次用户确认 |
| runtime | `runtime/scripts/desktop.mjs` + `runtime/src/helper.m` | 零 npm 依赖；AX 元素树与 CGEvent 键鼠都在 ObjC helper 里，首次用到时 clang 编译一次 |
| 运行条件 | `plugin.json` 的 `desktop.checks` | 只声明 id；状态由桌面端探测，显示在配置页的插件详情里，可一键跳到系统设置 |

## 确认与门禁

写命令（`tap` `setval` `type` `paste` `key` `press` `move` `click` `dclick` `rclick` `drag` `scroll`
`focus` `launch` `clip`）会改用户的鼠标、键盘、焦点或剪贴板，所以：

1. `computer_use` 工具先弹一张 dock 确认卡（目标 + 逐条人话步骤 + 「鼠标键盘会被真实占用」），
   用户点「允许」才继续；点「不要执行」/超时则一步都不跑；
2. 允许之后工具写一份**一次性许可文件**（内容是这次批准的具体命令，每条只能消费一次，2 分钟过期），
   经 `MICA_COMPUTER_USE_APPROVAL` 传给 `desktop.mjs`；
3. `desktop.mjs` 自己也会校验：没有覆盖这条命令的未消费许可就退出码 6 并给出「改用 computer_use」的提示——
   所以模型绕过工具直接 shell 调这些命令会失败，而不是悄悄接管用户的屏幕。

只读命令（`apps` `front` `screens` `els` `find` `text` `wait-el` `windows` `winlist` `webtext`
`shot` `winshot` `size` `pos` `check` `enable-ax`）不问，直接执行——它们不改用户的任何状态。

许可文件不是安全边界（模型理论上能自己造一个），它解决的是**误用**：让「没问过用户就动手」变成一条
立刻失败的路径。真正的边界仍然是用户在 Mac 上授予的辅助功能 / 屏幕录制权限。

## 多显示器

`screens` 是唯一事实来源：每块屏的 index / id / 是否主屏 / 是否为前台窗口所在屏 / 全局逻辑点 bounds /
真实像素与 scale。截图默认**每块屏各截一张**（第一张是前台窗口所在屏，其余加 `-d<index+1>` 后缀），
`--display <n|id>` 只截一块屏，`winshot <path> <app>` 按窗口截。坐标是跨屏的全局逻辑点（副屏在主屏
左边时 x 为负），所以 `move` / `click` / `drag` 可以直接指向任意一块屏。

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

写操作还额外依赖能向用户提问的宿主（`ctx.ask`，同样只有桌面端提供）：没有它时工具照常注册，
只读命令可用，写命令直接拒绝并说明原因——**不做「问不到人就直接执行」的降级**。

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

命令目录查询和步骤执行均异步运行，不阻塞停止请求；查询限时 20 秒、每步限时 2 分钟，单进程输出上限 1 MiB。
中止、超时或输出超限会终止运行时进程组并等待退出，后续步骤不再执行；批准许可在批次结束时统一删除。

鼠标移动在一次 helper 调用内读取原位置、移动并校验位置，减少两次 native 进程启动。
坐标、持续时间与等待超时在调用 native 工具前校验；组合键的每一段都确认合法后才发出任何键盘事件，空段（如 `cmd++a`）直接报错。

## 验证

```bash
bun run test -- plugins/computer-use
node $MICA_HOME/computer-use/scripts/desktop.mjs check
```
