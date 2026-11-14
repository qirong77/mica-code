# ask-dock · 提问卡片

`ask` 插件（`ctx.ask`）抛出的那张卡是**高优先级**的东西：这一轮正卡在这道题上，用户不答
就没有下文。所以这个探针盯的是「一屏里能不能最先看见它」，以及三件必须成立的事：

1. 卡片本身用 ask 那支青（`--color-ask`）立起来：描边、头部色带、选项边框、确认条；
   dock 版左右留边浮在输入条上方，不贴满整行。
2. **自由输入框永远在**：宿主即便下发 `display.input: false`（老宿主/老插件），
   输入框也不会消失——选项是模型想的，想不全时用户必须有地方说自己的答案。
3. 未选之前的「确定」是同一支青压暗，不会串成主题强调色。

```bash
cd apps/desktop
npx vite --config .probe/ask-dock/vite.config.mjs   # http://127.0.0.1:5238
```

页面顶部切主题（Darcula / Light / Mocha / Latte / Tokyo / Tokyo Light）与形态。四种形态：
多选题（3 个方案 + 自定义输入）、只写字、只确认（passive）、浮层（`presentation: 'modal'`，
默认关，开了会盖住其它三种）。点一个选项、在输入框里打几个字，可以看选中态与「确定」的可用态。

卡片是正式的 `AskDock`（`ChatView.jsx`），样式全部来自 `app.css`。卡片下面那条灰底输入条
只是给个上下文（真输入条是 `ChatComposer`，它带 CWD / 模型 / 计时一堆宿主依赖），不是产品。
