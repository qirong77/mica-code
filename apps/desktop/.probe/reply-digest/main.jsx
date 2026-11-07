// 探针「长回复摘要」：看 reply-digest 插件在一轮对话结束后追加的那张卡。
//
// 三件事必须和产品里一致，否则这个页面只能算示意图：
// 1. 样式：对话行、Markdown、摘要卡都用 app.css 的真实类名；
// 2. 判定：用插件自己的 digest.ts（shouldDigest / digestInput / cleanSummary），
//    不在这里抄一份阈值判断；
// 3. 结构：摘要卡就是 ChatView 的 DigestNotice 输出（section.chat-digest-card）。
//    只有摘要正文是固定样例——真跑起来时它由摘要模型生成。
import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import '../../src/renderer/assets/app.css'
import './probe.css'
import {
  cleanSummary,
  DEFAULT_CHAR_THRESHOLD,
  DEFAULT_INPUT_LIMIT,
  DEFAULT_LINE_THRESHOLD,
  DEFAULT_SUMMARY_LIMIT,
  digestInput,
  shouldDigest
} from 'plugins/reply-digest/digest.ts'

const LIMITS = {
  charThreshold: DEFAULT_CHAR_THRESHOLD,
  lineThreshold: DEFAULT_LINE_THRESHOLD,
  inputLimit: DEFAULT_INPUT_LIMIT,
  summaryLimit: DEFAULT_SUMMARY_LIMIT
}

const USER_MESSAGE = '帮我看下 reply-digest 的触发条件，是不是太敏感了？'

/** 一条典型的「值得摘要」的长回复：2000+ 字符、40+ 非空行。 */
const LONG_REPLY = [
  '## 判定发生在一轮结束之后',
  '',
  '`turn:after` 钩子在回合成功收尾时触发，只看 `outcome === "completed"`。中止、失败、`mica exec` 的一次性执行都不进摘要流程，所以短命进程里不会出现这张卡。',
  '',
  '### 取哪一条回复',
  '',
  '`session.messages(owner)` 拿到这一轮的消息，`lastAssistantText` 从后往前找最后一条 `role === "assistant"`，再用 `messageText` 把多块 content 拼起来，顺手去掉行尾空白：',
  '',
  '1. 只看文本块，工具调用与 thinking 块不参与；',
  '2. 旧轮次的消息不会混进来，摘要永远只描述刚刚那条回复；',
  '3. 前后空白被裁掉，避免「看起来很长、其实只有几行空行」的回复触发摘要。',
  '',
  '### 两个阈值是「或」的关系',
  '',
  '| 阈值 | 默认值 | 适合什么回复 |',
  '| --- | --- | --- |',
  '| 字符数 | 1800 | 长段落的解释型回答 |',
  '| 非空行 | 36 | 清单、代码、表格很多的回答 |',
  '',
  '32 行代码的回答可能不到 1800 字符，但它一样占满一屏，所以任意一条成立就触发。反过来，一条 2000 字符但只有 3 行的回答（比如被压成一段的总结）会按字符数触发。',
  '',
  '### 调用前后都做了裁剪',
  '',
  '- 送模型前用 `digestInput` 把正文裁到 `inputLimit`（默认 12000 字符），末尾补一个省略号，避免把超长内容整份重发一次；',
  '- 模型返回后 `cleanSummary` 去掉围栏、去掉「摘要：」这类前缀，再按 `summaryLimit`（默认 600 字符）截断；',
  '- 清理后为空按失败处理：`health.report` 记一条 warn，原回复不受影响。',
  '',
  '### 去重与并发',
  '',
  '同一个会话记录 `handled`（sessionId → inputId），同一轮即使钩子被重复派发也只摘要一次；新的一轮进来时先把上一条还在跑的请求 abort 掉，避免摘要错写到正在看的另一条会话。`handled` 最多留 50 条，超出丢最旧的，内存不会随会话时长增长。',
  '',
  '### 摘要卡为什么是独立 notice',
  '',
  '它既不把原回复折起来，也不往消息里塞一段灰字：`variant: "digest"` 让它以 notice 身份进入消息流，渲染层据此走 `DigestNotice` 分支，而不是普通的 `/compact` 状态行。这样三件事同时成立：',
  '',
  '- 卡片在会话快照里可回放，重启后仍在原位；',
  '- 摘要正文继续走对话区的 Markdown 渲染器，标题、列表、表格、行内代码都能用；',
  '- 清理、复制、引用这些按消息类型分派的行为不会把摘要当成 agent 的原话。',
  '',
  '### 失败时用户看到什么',
  '',
  '- 摘要模型没配置：一条 warn，提示去插件设置里复用当前会话模型；',
  '- 请求超时或报错：同样一条 warn，原回复照常显示，消息流里不会留下半张卡；',
  '- 摘要在生成中被新一轮覆盖：旧请求 abort，结果丢弃，不写 notice。',
  '',
  '这些分支都不会重试：摘要是锦上添花，重试只会让后台悄悄多花 token。',
  '',
  '### 这一版没做的三件事',
  '',
  '- 摘要不缓存：刷新界面不会重算，也不会存回快照，卡片就是消息流里那条 notice；',
  '- 摘要不参与 token 统计：它单独记账，不会把这一轮对话的成本算高一倍；',
  '- 摘要不单独控制样式：它走对话区的 Markdown 渲染器，换字号、换主题时跟正文一起变。',
  '',
  '### 怎么自己验证',
  '',
  '1. 在 `plugins/reply-digest` 下跑 `bun test`，`digest.test.ts` 覆盖了阈值触发、输入截断和摘要前缀清理；',
  '2. 起桌面端，问一个需要详细讲解的问题，让回复自然超过一屏，回合结束后卡片会追加在回复下面；',
  '3. 把 `charThreshold` 临时改成 200 再发一句短消息，就能看到「短回复也触发」是什么观感——那正是阈值定得太低的后果。',
  '',
  '### 我建议不要动的两处',
  '',
  '1. **不要把字符阈值压到 600 以下。** 600 字符大约就是「四五段原理说明」，这种长度用户自己扫一眼就完了，加卡片只是制造噪音；',
  '2. **不要让摘要复用工具调用。** 现在只读文本块是刻意的：工具输出又长又碎，混进来会让摘要变成一句「跑了几个命令」，没有信息量。',
  '',
  '真要调，先把 `charThreshold` 提到 2400 观察一周；不要同时压低非空行阈值，也不要换更小的模型——摘要质量掉下去之后，用户会连原回复一起不信任。'
].join('\n')

/** 一条不该触发摘要的短回复。 */
const SHORT_REPLY = [
  '确认了：`reply-digest` 只在 `turn:after` 且回合成功时工作，字符 1800 / 非空行 36 任一满足才调摘要模型，送模型前裁到 12000 字符，卡片正文最多 600 字符。',
  '',
  '这条回复两条阈值都没到，插件不会调用模型，也不会往消息流里加卡。'
].join('\n')

/** 字符数不到 1800、但行数过线的回复：演示「任一阈值成立即触发」。 */
const LINE_REPLY = Array.from(
  { length: 40 },
  (_, index) => `${index + 1}. 检查第 ${index + 1} 项：已确认无需改动`
).join('\n')

/** 一次真实摘要模型的样例输出，和 prompt 里要求的「最多 4 个要点」对齐。 */
const SUMMARY_SAMPLE = [
  '- 判定在 `turn:after`、且只在回合 `completed` 时跑；中止、失败与 `mica exec` 一次性执行直接跳过。',
  '- 只读最后一条 assistant 的文本块：工具调用、thinking、旧轮次都不进摘要，行尾空白会先裁掉。',
  '- 触发是「字符 ≥ 1800」或「非空行 ≥ 36」，任一条成立；送模型前正文裁到 12000 字符。',
  '- 摘要清理后最多 600 字符，为空按失败上报；同一轮只摘要一次，新一轮进来会 abort 旧请求。',
  '- 现状建议：别把字符阈值压到 600 以下，也别让摘要吃工具输出。'
].join('\n')

const THEMES = [
  { id: 'dark', label: '暗色' },
  { id: 'light', label: '亮色' },
  { id: 'mocha', label: 'Mocha' }
]
const APPEARANCE = {
  dark: 'dark',
  light: 'light',
  mocha: 'dark',
  latte: 'light',
  'tokyo-night': 'dark',
  'tokyo-night-light': 'light'
}

// 与 digest.ts 的 shouldDigest 同一口径，只用来把数字画成进度条；判定本身走 shouldDigest。
const countLines = (text) => text.split('\n').filter((line) => line.trim()).length

// 与 ChatView 的 Markdown 组件同样的 table 包装：横向滚动由 .chat-table-wrap 负责。
const MD_COMPONENTS = {
  table: ({ children }) => (
    <div className="chat-table-wrap">
      <table>{children}</table>
    </div>
  )
}

function Meter({ label, value, threshold, unit }) {
  const ratio = threshold > 0 ? Math.min(1, value / threshold) : 0
  const over = value >= threshold
  return (
    <div className="probe-meter">
      <div className="probe-meter-head">
        <span>{label}</span>
        <span>
          <b>{value.toLocaleString('zh-CN')}</b> / {threshold.toLocaleString('zh-CN')} {unit}
        </span>
      </div>
      <div className="probe-meter-track">
        <div
          className={`probe-meter-fill ${over ? 'is-hot' : ''}`}
          style={{ width: `${Math.max(ratio * 100, value > 0 ? 3 : 0)}%` }}
        />
      </div>
    </div>
  )
}

function Markdown({ text }) {
  return (
    <div className="chat-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS} skipHtml>
        {text}
      </ReactMarkdown>
    </div>
  )
}

function ChatRow({ role, text }) {
  const [expanded, setExpanded] = useState(false)
  const long = text.length > 900 || text.split('\n').length > 12
  return (
    <div className={`chat-message chat-message-${role}`}>
      <div className="chat-message-marker">{role === 'user' ? '▌' : '●'}</div>
      <div className="chat-message-body">
        {role === 'user' ? (
          text
        ) : (
          <>
            <div
              className={`chat-message-collapsible ${long && !expanded ? 'chat-message-collapsible-clipped' : ''}`}
            >
              <Markdown text={text} />
            </div>
            {long && (
              <button
                type="button"
                className="chat-message-collapse-toggle"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? '收起' : '展开完整回复'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** ChatView 里 DigestNotice 的输出，一个类名都不改。 */
function DigestCard({ text }) {
  return (
    <section className="chat-digest-card" aria-label="长回复摘要">
      <div className="chat-digest-head">
        <span className="chat-digest-mark" aria-hidden="true">
          ✦
        </span>
        <span className="chat-digest-title">长回复摘要</span>
        <span className="chat-digest-meta">自动整理</span>
      </div>
      <div className="chat-digest-body">
        <Markdown text={text} />
      </div>
    </section>
  )
}

function Side({ reply, onReply, summaryLength, fired, chars, lines, sent }) {
  return (
    <aside className="probe-pane probe-side">
      <div className="probe-side-head">
        <span className="chat-digest-mark" aria-hidden="true">
          ✦
        </span>
        Long Reply Digest
        <span className="probe-side-id">reply-digest</span>
        <span className="probe-side-version">v1.0.0</span>
      </div>
      <p>
        回合结束后读最后一条 assistant 回复；超过阈值才调摘要模型，结果以{' '}
        <code>variant: &quot;digest&quot;</code> 的 notice 追加到消息流。
      </p>

      <div className="probe-section">
        <span className="probe-section-title">本轮判定</span>
        <div className={`probe-verdict ${fired ? '' : 'is-off'}`}>
          <span className="probe-verdict-glyph">{fired ? '✓' : '—'}</span>
          {fired ? '会生成摘要' : '不触发，不调用模型'}
        </div>
        <p className="probe-hint">两个阈值任一成立就触发；都不满足时插件根本不会调用模型。</p>
        <Meter label="字符数" value={chars} threshold={LIMITS.charThreshold} unit="字符" />
        <Meter label="非空行" value={lines} threshold={LIMITS.lineThreshold} unit="行" />
      </div>

      <div className="probe-section">
        <span className="probe-section-title">请求与输出</span>
        <ul className="probe-facts">
          <li>
            <b>送模型</b>
            <span>
              {sent.toLocaleString('zh-CN')} 字符
              {sent < chars
                ? `（原文 ${chars.toLocaleString('zh-CN')}，已按 ${LIMITS.inputLimit.toLocaleString('zh-CN')} 截断）`
                : '（未截断）'}
            </span>
          </li>
          <li>
            <b>摘要</b>
            <span>
              {summaryLength} 字符 / 上限 {LIMITS.summaryLimit}
            </span>
          </li>
          <li>
            <b>模型</b>
            <span>复用当前会话模型（也可在插件设置里单独配）</span>
          </li>
          <li>
            <b>落点</b>
            <span>独立 notice 卡，不阻塞回合收尾</span>
          </li>
        </ul>
      </div>

      <div className="probe-section">
        <span className="probe-section-title">试一条回复</span>
        <textarea
          className="probe-textarea"
          value={reply}
          spellCheck={false}
          onChange={(event) => onReply(event.target.value)}
        />
        <div className="probe-buttons">
          <button
            type="button"
            className={reply === LONG_REPLY ? 'is-active' : ''}
            onClick={() => onReply(LONG_REPLY)}
          >
            长回复样例
          </button>
          <button
            type="button"
            className={reply === SHORT_REPLY ? 'is-active' : ''}
            onClick={() => onReply(SHORT_REPLY)}
          >
            短回复样例
          </button>
          <button
            type="button"
            className={reply === LINE_REPLY ? 'is-active' : ''}
            onClick={() => onReply(LINE_REPLY)}
          >
            只有行数过线
          </button>
          <button type="button" onClick={() => onReply('')}>
            清空
          </button>
        </div>
        <div className="probe-note">
          改上面的文本，左边对话区和判定会一起更新。卡片里的摘要文字是一次样例输出——真实运行时由摘要模型生成，
          这里不联网，所以它不随文本变化。
        </div>
      </div>

      <div className="probe-section">
        <span className="probe-section-title">主题</span>
        <div className="probe-buttons">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              type="button"
              onClick={() => {
                document.documentElement.setAttribute('data-theme', theme.id)
                document.documentElement.setAttribute(
                  'data-appearance',
                  APPEARANCE[theme.id] || 'dark'
                )
              }}
            >
              {theme.label}
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}

function Probe() {
  const [reply, setReply] = useState(LONG_REPLY)
  const summary = useMemo(() => cleanSummary(SUMMARY_SAMPLE, LIMITS.summaryLimit), [])
  const chars = reply.length
  const lines = countLines(reply)
  const fired = shouldDigest(reply, LIMITS)
  const sent = digestInput(reply, LIMITS.inputLimit).length

  return (
    <div className="probe-shell">
      {/* chat-view 不是装饰：对话排版变量（--chat-user、--chat-row-marker-width）
          挂在它上面，少了这条类名，用户消息带和 gutter 宽度都不是真实值。 */}
      <div className="probe-pane probe-chat chat-view">
        <div className="probe-chat-tab">
          <strong>会话</strong>
          <span>reply-digest 演示 · 一轮已完成</span>
          <span className="probe-tab-hint">输入条与工具行省略</span>
        </div>
        <div className="chat-transcript">
          <ChatRow role="user" text={USER_MESSAGE} />
          <ChatRow role="assistant" text={reply} />
          {fired && <DigestCard text={summary} />}
        </div>
        {!fired && (
          <div className="probe-absent">
            <strong>这条回复不会触发摘要。</strong> 字符 {chars}、非空行 {lines}，两条阈值（1800
            字符 / 36 行）都没到， 插件不会调用模型，消息流里也不会出现卡片。
          </div>
        )}
      </div>
      <Side
        reply={reply}
        onReply={setReply}
        summaryLength={summary.length}
        fired={fired}
        chars={chars}
        lines={lines}
        sent={sent}
      />
    </div>
  )
}

createRoot(document.getElementById('root')).render(<Probe />)
