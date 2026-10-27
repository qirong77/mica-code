---
name: computer-use
description: 用 Node + Objective-C helper 在本地操作 macOS 桌面 —— 移动/点击鼠标、输入文字、按快捷键、截图，并自带 AX 元素树（按控件名字点击、读界面文本、驱动浏览器网页）。纯本地实现（CGEvent + AX，无 npm 依赖），不依赖任何云服务或外部 app。
when_to_use: Use when a task needs macOS desktop input/output — e.g. "在这个位置上点一下", "帮我按 cmd+s", "把这段字打进去", "截个图看看", "拖动这个窗口", "点一下那个按钮", "读一下界面上的文字", "帮我在浏览器里点开/填表单/读页面内容", "自动点一系列坐标".
argument_hint: [要做的键鼠/截图/元素树操作]
---

# computer-use

在 macOS 上做桌面自动化的本地方案：**一个 Objective-C helper（AX 元素树 + CGEvent 键鼠）+ 系统 `screencapture`**，
外面套一层纯 Node 的 CLI。**不需要 `npm install`，不需要任何 App，也不依赖云服务。**

> 自带元素树（AXUIElement），所以「按控件名字点」「读界面文本」「驱动浏览器」都能做，而且比坐标点击更稳。
> **优先用 AX，坐标只是兜底。**

## 构建与运行

`{{RUNTIME_DIR}}` 是运行时目录，里面有 `src/helper.m`、`scripts/desktop.mjs`，以及编译产物 `bin/helper`。

```bash
D="node {{RUNTIME_DIR}}/scripts/desktop.mjs"
$D check          # 先自检：权限 + clang
```

- **helper 首次使用时自动编译**（源码比二进制新也会重编译），只需要 Xcode Command Line Tools 里的 `clang`。
  手动编译：`clang -O2 -framework ApplicationServices -framework CoreGraphics -framework Foundation src/helper.m -o bin/helper`
- `check` 会报告：辅助功能 / 屏幕录制权限、`xcode-select -p`、`clang --version`、平台。缺 CLT 时提示 `xcode-select --install`。
- 运行时目录可以用环境变量 `MICA_COMPUTER_USE_DIR` 覆盖。
- helper 用 **Objective-C** 写：本机 `swiftc` 已损坏（编译器比 SDK 新，`import Foundation` 都编译不过），**不要**改成 Swift。

## 系统权限（必须，否则静默失效）

系统设置 → 隐私与安全性 → 打开 **辅助功能** 与 **屏幕录制** → 勾选**运行 Mica 的那个 app**（`mica-code-app` 等）。
**改完权限要重启那个 app。**

- 没有**辅助功能**：AX 命令直接报错，`move`/`click` 等事件会被系统静默丢弃（`move` 已经带读回校验，会明确报 `MOVE FAILED`）
- 没有**屏幕录制**：`shot` 产出的是桌面壁纸，不是窗口内容

**权限没开时，先让用户在桌面端的 Computer Use 页面里处理**：那个页面能一键跳到系统设置对应项并刷新状态，
比让用户自己找路径可靠得多。开完权限再 `$D check` 确认。

## 用哪个：AX 还是坐标

| 场景                       | 用什么                                | 为什么                                 |
| -------------------------- | ------------------------------------- | -------------------------------------- |
| 按名字点按钮 / 开关 / 链接 | `tap`（AXPress）                      | **不抢焦点**、不怕窗口移动、不用算坐标 |
| 读界面文字/状态            | `text` / `els` / `find`               | 免 OCR，直接拿 AX 值                   |
| **读网页内容**             | `webtext`                             | 免截图、免 OCR，按文档顺序出文本       |
| 菜单栏、侧栏列表项         | `tap`（`--menus`）                    | 坐标点菜单栏很容易点歪                 |
| 在输入框打字（含网页表单） | `tap`/`click` 聚焦后 `type` / `paste` | 很多控件不认 `setval` 的提交（见下）   |
| 拖动、画布、游戏、自绘 UI  | `move`/`click`/`drag`                 | 这些没有可用元素树                     |
| 纯截图                     | `shot`                                | 最快（~0.2s）                          |

## 命令

```bash
D="node {{RUNTIME_DIR}}/scripts/desktop.mjs"
$D help        # 完整列表
```

### AX（首选）

```bash
$D apps                              # 列出有窗口的 app
$D front                             # 当前前台 app
$D els  <app> [--depth N]            # 元素树（JSON，含 role/title/value/desc/坐标/可点性）
$D find <app> <query>                # 找元素（query 匹配 role/title/value/desc）
$D tap  <app> <query>                # ★ AXPress 点击（后台，不抢焦点）
$D setval <app> <query> <value>      # 写 AX value（注意：见下面的"陷阱"）
$D text <app> [query]                # 读元素文本值（验证结果用）
$D wait-el <app> <query> [ms]        # 等元素出现（默认 10s）—— 替代死等 sleep
$D windows <app>                     # 窗口列表
$D webtext <app>                     # ★ 网页区域纯文本（浏览器任务）
$D enable-ax <app>                   # 运行时开启 Chrome/Electron 网页可访问性
```

`<app>` 接受本地化名（计算器）、英文可执行名（Calculator）、或 pid。
所有命令加 `--json` 出机器可读结果（此时 stdout 只有 JSON，诊断走 stderr）。

### 坐标级键鼠（兜底）

```bash
$D size / pos                        # 屏幕逻辑尺寸（同时报物理像素）/ 当前鼠标位置
$D shot <path> [x,y,w,h]             # 截图（PNG）
$D winshot <path> <windowId>         # 截指定窗口
$D move <x> <y>                      # 移动（移动后读回校验，失败退出码 4）
$D click [x y] / dclick [x y] / rclick [x y]
$D drag <x1> <y1> <x2> <y2> [ms]     # 拖拽，默认 300ms，带中间态拖拽事件
$D scroll <up|down|left|right> [n]   # 滚轮（也接受 scroll <dy> [dx]）
$D type <text>                       # 整串打字（任意 Unicode，进当前焦点控件）
$D paste <text>                      # 剪贴板 + Cmd+V（长文本/CJK/富文本更稳）
$D key <name>                        # 单键：enter tab esc space up down f1..f12 cmd shift ...
$D press <mod+key>                   # 组合键：cmd+s、shift+cmd+4、ctrl+alt+delete
$D focus <app> / launch <app> / wait <ms>
$D highlight <x> <y> <w> <h>         # 把该区域截成临时 PNG（坐标校对用，不画浮动窗口）
```

## 浏览器任务（实测可用）

浏览器会把网页 DOM 投影进 AX 树，所以**整个页面都是元素树**：
按链接文字点击、按按钮名提交、按文档顺序读正文——不需要截图，也不需要 OCR。

### 关键前提：Chrome 要先开启可访问性

**Safari 开箱即用**；**Chrome / Electron 默认关闭渲染器可访问性**，
此时元素树里只有浏览器工具栏（约 60 个节点），看不到任何网页内容。

```bash
$D enable-ax "Google Chrome"        # 运行时开启，免重启、免启动参数
$D els "Google Chrome" | grep -c WebArea   # 确认已生效
```

`enable-ax` 的实现要点（改动时注意）：设置私有属性 `AXManualAccessibility` /
`AXEnhancedUserInterface` 时 `AXUIElementSetAttributeValue` **会返回 -25205/-25208（未支持）**，
**但 Chromium 已经因此打开了可访问性**——所以**不能只看返回码**，
必须重新枚举元素确认 `AXWebArea` 是否真的出现（helper 内部就是这么判定的）。
另一个办法是启动时加 `--force-renderer-accessibility`，但那样无法接入**用户已经开着的** Chrome。

### 套路

```bash
D="node {{RUNTIME_DIR}}/scripts/desktop.mjs"

# 1) 打开页面（open -a 比 AppleScript 可靠）
open -a Safari "http://127.0.0.1:8899/"
$D focus Safari
$D wait-el Safari AXWebArea 8000         # 等网页内容进树，而不是 sleep

# 2) 按链接/按钮名字点击（后台 AXPress）
$D tap Safari "Go to Page Two"

# 3) 等目标内容出现，再读页面文本
$D wait-el Safari "PAGE2-MARKER-7741" 8000
$D webtext Safari

# 4) 填表单：先 AX 聚焦输入框，再键盘输入
$D tap Safari "Search query"
$D type "hello"
$D tap Safari "Search Now"
$D webtext Safari                        # 读回显验证
```

浏览器任务里**不要**用 AppleScript 读 URL（见陷阱 12），地址栏本身就是 AX 元素。

## 关键陷阱（都是实测踩出来的）

1. **点任何东西之前先确认没有模态弹窗**
   一个系统错误弹窗会把**所有**输入吃掉、`focus` 也失效，表现为「命令都成功但什么也没发生」。
   排查：`$D shot /tmp/x.png` 看一眼，或 `$D front` 发现前台不对。模态弹窗可能属于**别的进程**，
   杀掉你以为的元凶（如系统设置）也不一定消失——用 `Return` / `Esc` 试，或直接点它的按钮。

2. **`focus` 是先决条件（只对键盘/坐标操作）**
   `type`/`key`/`press`/`click` 都发给**当前前台 app**，先 `$D focus <app>`（必要时再点一下输入框）再操作。
   **`tap` 不需要**，它走 AX，天生后台。
   注意：点击非前台 app 时，第一次点击只是激活窗口；Electron 类应用激活后输入焦点也可能还没进输入框，
   这时先 `tap`/`click` 那个输入框再打字。

3. **`type` 打不进去时先确认「输入焦点在输入框里」**
   `type` 是整串一次性发出（`CGEventKeyboardSetUnicodeString`，任意 Unicode 都支持），
   但如果目标 app 的当前窗口没有活动的文本输入控件，事件会被丢掉（命令仍然返回成功）。
   稳妥做法：`tap <app> "<输入框名>"` 或 `click x y` 点进输入框 → `$D type "..."` → **`text`/`wait-el` 读回校验**。
   长文本、含 emoji 的文本、富文本优先用 `$D paste "..."`（剪贴板 + Cmd+V），失败时它会自动退回 `type`。

4. **AX `setval` 会写进值，但不一定触发「提交」**
   实测：TextEdit 正文能写进去；**Finder 的行内改名框**、**Safari/Chrome 网页表单**都不认它
   （会报成功、但读回是空）。结论：**文本输入一律用 `type`/`paste`**（先 `tap` 元素拿焦点），
   `setval` 只用于确实读 value 的控件，并且**写完必须读回校验**。

5. **改 Chrome 的网页内容前必须先 `enable-ax`**（见上），否则只会看到工具栏。

6. **标签常在 `desc` 而不是 `title`**
   计算器按钮 `title` 是空的、标签在 `desc`（'乘'、'等于'）。本 skill 的匹配和 `find` 都覆盖 title/desc/value/role。

7. **Retina 2x：截图是物理像素，坐标是逻辑点**
   `size` 同时给出逻辑尺寸与物理像素（例如逻辑 1512×982 / 物理 3024×1964）。
   `move`/`click`/`drag` 用的是**逻辑点**。**不要把截图像素直接当坐标用**——
   先换算（除以缩放倍数），或按逻辑尺寸缩放截图：`sips -Z <逻辑宽> shot.png`。

8. **`key space` 单独发空格键不可靠**
   整串 `type "a b c"` 是好的；**单独发空格键**在某些 app 会丢。
   要打含空格的字符串就整串 `type`，或用 `paste`。

9. **回车用 `enter`（= Return 36）**
   `enter`/`return` 都映射到主回车；`keypadenter` 是小键盘回车（103）。对话框默认按钮、行内改名用主回车。

10. **菜单默认不参与匹配**
    `find`/`tap` **不含菜单栏**——否则「点计算器的 1」会静默点到同名菜单项。
    要操作菜单栏加 `--menus`；且**子菜单要先打开**才会进元素树（先 `tap` 菜单标题，再 `tap` 子项）。

11. **没有可见窗口的 app 也解析得到**
    `resolvePid` 先按窗口 owner 名匹配，再退回进程列表（可执行名/.app 名），
    所以关掉所有窗口的 Finder 也能被 `windows Finder` 找到。但**本地化名没有窗口时就查不到**
    （只有窗口 owner 名是本地化的），这种情况用英文名或 pid。

12. **写 shell 脚本时：`D="node <路径>"` 必须不带引号使用**
    `"$D" webtext Safari` 会把「node /路径」当成**一个文件名**，静默失败（配上 `2>/dev/null` 极难查）。
    用 `$D webtext Safari`（不加引号）或 `D=(node "<路径>"); "${D[@]}" webtext Safari`。
    —— 这个坑真实导致过一整轮「全部 FAIL 且输出为空」的误判。

13. **不要用 AppleScript 读浏览器 URL**
    `osascript -e 'tell application "Safari" to return URL of front document'` 实测会**挂住**。
    地址栏本身就是 AX 元素（`AXTextField` / `AXComboBox`），`$D els Safari` 直接能读到。
    （`focus` 的兜底用 `osascript ... to activate` 是安全的，那只是激活 app。）

14. **`front` 只是「最上层窗口」的近似**
    它取 CGWindowList 里第一个 layer 0 窗口，多显示器 / 多窗口时不一定等于「当前键盘焦点所在的 app」。
    判断「键盘输入会去哪」不要只信 `front`，需要确定就用 `focus <app>` 显式激活。
    桌面元素被排除在列表外，所以只显示桌面时 `front` 可能报出别的 app。

15. **`highlight` 不是闪烁高亮**
    macOS 上画浮动窗口需要 AppKit，helper 只链了 ApplicationServices/CoreGraphics/Foundation，
    所以 `highlight` 改成「把这块区域截成临时 PNG」——坐标校对看这张图最直接。

## 推荐套路

```bash
D="node {{RUNTIME_DIR}}/scripts/desktop.mjs"

# 1) 先看权限/前台/有没有挡路的弹窗
$D check
$D front

# 2) 用 AX 定位并点击（后台，不抢焦点）
$D find Calculator "乘"          # 确认匹配到的确实是要点的那个元素
$D tap  Calculator "乘"

# 3) 等状态变化（不要 sleep 固定秒数）
$D wait-el Calculator "56,088" 5000

# 4) 读回结果校验，而不是靠"看起来成功了"
$D text Calculator
```

需要键盘输入时：

```bash
$D focus TextEdit && $D wait 800
$D type "Mica desktop test OK"      # 整串打字，空格不会丢
$D key enter
```

## 真实页面 / 真实站点（与模拟页面的关键差别）

### 1. 长页面的节点上限：`els` 有上限，`find`/`tap`/`webtext` 没有

`els` / `tree`（整棵树 dump）受 **5000 节点 / 24 层**限制——这是为了可控的内存与耗时。
**真实页面动辄上万节点**（维基百科 macOS 版本历史 > 5000），所以 dump 出来的树**可能是被截断的**。
helper 在这种情况下会往 **stderr** 打一行 `note: 树已被截断…`，不要忽略它。

**但 `find` / `tap` / `setval` / `wait-el` / `webtext` 走流式遍历，不受这两个上限约束**：
遍历时不保留整棵树，边遍历边判定/输出，所以能命中文档最末的元素。

```bash
# 页脚元素在旧上限之外，照样能命中
$D find Safari "Cookie statement"

# 读整页正文（一次遍历，含页脚）
$D webtext Safari | tail -5
```

实测：修复前维基百科长条目只读到 2014 年的 Yosemite，**2023 Sonoma / 2024 Sequoia
以及页脚全部丢失**；改成流式遍历后整页可读。

### 2. 浏览器之间的坐标口径不同 —— 不要断言具体 y 值

同一个页脚链接：**Safari** 给的是**文档坐标**（相对整篇文档，含滚动部分，例如 `y=17444`）；
**Chrome** 给的是**视口相对坐标**（例如 `y=893`）。

所以**不要**写「元素 y 必须 > 8000」这种断言；要判断「够不够深」，
用「能不能读到页脚文本」这类内容断言。

### 3. 真实站点的控件 role 不统一

搜索框在 Bing 上是 **`AXComboBox`**（不是 `AXTextField`），匹配/校验时别写死 role。
判断输入是否成功，读回 `value` 比按 role 过滤可靠。

### 4. Electron 应用：`enable-ax` 有效，但画布内容仍然看不见

VS Code 这类 Electron 应用默认同样不暴露 UI；`enable-ax` 之后元素树从 ~12 个涨到 ~34 个并出现 `AXWebArea`。
但**编辑器主体是 canvas 绘制的（Monaco），不产生 AX 节点**——这类内容只能靠截图 + 视觉模型。

### 5. 动态内容要用 `wait-el`，不要固定 sleep

真实页面的结果是异步渲染的。搜索提交后要等结果出现：

```bash
$D tap Safari "输入搜索词" && $D type "macos accessibility api"
$D key enter
$D wait-el Safari "个结果" 10000      # 等真实结果出现，而不是 sleep 4
```

## helper 的低层接口

`bin/helper` 也可以直接用，输出**恒为 JSON**，失败时输出 `{"error": "..."}` 并返回非零码。

```bash
./bin/helper apps | frontmost | windows <app> | pos | size | check
./bin/helper tree   <app> [--depth N] [--limit N] [--menus]
./bin/helper find   <app> <query> [--menus]
./bin/helper press  <app> <query> [--menus]    # AXPress（两个参数时）
./bin/helper setval <app> <query> <value>
./bin/helper focus  <app>
./bin/helper webtext  <app>        # 网页区域纯文本
./bin/helper enable-ax <app>       # 开启 Chromium 系可访问性
./bin/helper wait-el <app> <q> [--timeout ms]

# 输入（CGEvent）
./bin/helper move <x> <y> | click [x y] [--button left|right] [--count N]
./bin/helper drag <x1> <y1> <x2> <y2> [--duration ms] | scroll <dy> [dx]
./bin/helper type <text> | key <name> | chord <mod+key>   # press <mod+key> 也等价
```

- 元素 JSON 字段：`role/title/value/desc/depth/pressable/focused/settable/actions/x/y/w/h/cx/cy`。
- `--menus` 才带菜单栏；默认不带。
- `scroll` 的符号：`dy > 0` 向上滚（内容下移），`dx > 0` 向左滚。
- `check` 输出 `{accessibility, screenRecording}`（布尔）；clang / CLT 由 `desktop.mjs check` 补。

## 实测效果（沿用旧版实机结论，macOS 26 / M 系列）

| 任务                                                       | 结果                                    |
| ---------------------------------------------------------- | --------------------------------------- |
| 计算器 `123×456`（9 次元素点击 + AX 读回）                 | **PASS，~0.9s，全程不抢焦点**           |
| Finder 新建文件夹 + 重命名                                 | PASS，约 14s（必须 `focus` + 键盘输入） |
| 截图 + AX 读屏（免 OCR）                                   | PASS，截图 226ms                        |
| 浏览器：点链接跳转 / 填表单提交 / 读表格（Safari）         | **6/6 PASS**，读页面文本 ~150ms         |
| 浏览器：同上（Chrome，需先 `enable-ax`）                   | **6/6 PASS**，读页面文本 ~180ms         |
| **真实站点**：搜索引擎输入/提交/读结果（Safari、Chrome）   | **3/3 PASS** ×2                         |
| **真实站点**：维基百科长条目整页可读（含页脚，旧上限之外） | **6/6 PASS** ×2                         |
| **真实站点**：GitHub 仓库页提取 star 数（Safari、Chrome）  | **3/3 PASS** ×2                         |
| **真实 Electron**：VS Code `enable-ax` + 树/窗口可读       | **3/3 PASS**                            |

结论：**能用 AX 就用 AX**；需要打字/拖拽/纯截图时降级到坐标与键盘。
