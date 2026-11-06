# Voice Input

手机端输入框旁的麦克风按钮：录一段话，转成可编辑文字放进草稿，由用户确认后再发送。桌面端不显示这枚按钮（桌面自带系统听写，输入框右侧留给其它动作）。

## 怎么用

1. 在 **Settings → Plugins → Voice Input** 填好语音转写服务（OpenAI 兼容）。
2. 手机打开会话，点输入框旁的麦克风，首次会请求麦克风权限。
3. 说完点「结束录音」，识别出的文字追加到草稿末尾（已输入的内容保留，音轨前后会换行分隔）。
4. 文字可以直接改，觉得不对就删掉重录。转写失败时这一条录音留在内存里，可以点「重试转写」；换页面或切走会话会导致录音作废。

## 设置项

| 键 | 说明 |
| --- | --- |
| `baseUrl` | 服务地址。填 `/v1` 这样的基址，插件自己接 `/audio/transcriptions`；也可以直接填完整接口地址。 |
| `apiKey` | 鉴权用的 Key，只存在本机 `$MICA_HOME/plugin-settings/voice-input.json`，不进手机页面。本地免鉴权服务可以留空。 |
| `model` | 语音识别模型，默认 `whisper-1`。 |
| `language` | 语言代码（默认 `zh`）；留空由服务自动识别。 |

面板里的「检查配置」只校验地址与字段格式，真正的连通性在第一次转写时才知道。

## 链路与边界

- 浏览器录音 → `POST /api/attachment`（与「添加附件」同一条上传通道，文件名 `voice-input-*.webm|m4a|ogg|wav`）→ 本机按插件动作 `transcribe` 调语音服务 → 识别文字回填草稿。手机端没有 Key，也不能自己访问语音服务。
- 录音在**本机进程**里读取与删除，只接受 `$MICA_HOME/attachments/` 下、名字符合本插件格式、非符号链接的普通文件；转写成功或失败都会删掉临时文件。
- 每段录音上限 120 秒 / 10 MiB，转写请求 35 秒超时。
- 需要 HTTPS（手机经中转机访问时本来就是 https）：`getUserMedia` 在非安全上下文里不可用，页面上会直接说明。
- 切到后台、离开页面、切换会话都会结束录音并释放麦克风；迟到的上传和识别结果按录音版本丢弃，不会写进别人的草稿。

## 支持的浏览器

按顺序挑 `audio/webm;codecs=opus` → `audio/mp4` → `audio/ogg;codecs=opus` → `audio/webm`，都没有就直说当前浏览器不支持，不做静默降级。iOS Safari 走 `audio/mp4`（`.m4a`），Android Chrome 走 webm/opus。

## 代码

- `index.ts`：注册插件，处理 `check` / `transcribe` / `discard` 三个会话级动作。
- `recording.ts`：临时录音文件的安全读取与清理。
- `transcribe.ts`：配置校验 + 调 OpenAI 兼容的转写接口。
- `recorder.js`：与界面无关的录音状态机（权限、计时、上限、取消、重试），宿主能力以参数注入，便于单测。
- `desktop.jsx`：输入框里那枚麦克风（`Composer` 导出），只有手机布局渲染。
