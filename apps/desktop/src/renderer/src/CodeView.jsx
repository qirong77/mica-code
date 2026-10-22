import { useMemo } from 'react'
import { PathText } from './PathToken'
import { highlightCode } from './code-highlight'

// 路径识别只对可能含路径的片段跑：5000 行输出里逐 token 走一遍正则太贵，
// 而绝大多数 token（关键字、数字、标点）本来就不可能有路径。
const PATH_HINT = /[/\\~]/

function withPathLinks(text) {
  if (!text || !PATH_HINT.test(text)) return text
  return <PathText text={text} />
}

/**
 * 只读代码块：`code-highlight.js` 的着色结果 + 原有的路径点击。
 *
 * 仍然是一个 `<pre>`，调用方传原来的 class（`.chat-code-block`、`.chat-modal-pre`）
 * 就能沿用既有边框/内边距；这里只负责 token 上色与换行方式。
 * `wrap` 默认关闭（横向滚动，和编辑器一致）；日志类输出才开。
 */
export function CodeView({ text, language = 'text', wrap = false, className = '' }) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  const tokens = useMemo(() => highlightCode(source, language), [source, language])
  const classes = ['code-view']
  if (wrap) classes.push('is-wrap')
  if (className) classes.push(className)

  return (
    <pre className={classes.join(' ')} data-language={language}>
      {tokens.map((token, index) => {
        const content = withPathLinks(token.text)
        // 纯文本且没有路径时直接返回字符串：不为每一段再套一层 span。
        if (token.type === 'plain' && content === token.text) return content
        return (
          <span
            className={token.type === 'plain' ? undefined : `code-tok code-tok-${token.type}`}
            key={index}
          >
            {content}
          </span>
        )
      })}
    </pre>
  )
}
