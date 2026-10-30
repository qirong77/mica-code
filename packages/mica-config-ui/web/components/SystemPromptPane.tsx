import { useEffect, useMemo, useState } from 'react';
import { readSessionSystemPrompt } from '../api.js';
import { JsonEditor } from './JsonEditor.js';
import { Button } from './Ui.js';
import { formatCharCount } from '../format.js';
import { splitPromptSections, summarizePrompt } from '../promptView.js';
import type { ConfigWebSessionPrompt } from '../../src/shared/types.js';

const NOTICE_MS = 1800;

/**
 * 系统提示词：这条会话最近一次请求**真正发出去**的那一份。
 *
 * 它不是角色文件里那一段：`buildSystemPrompt()` 会把 AGENT.md、skills 索引、环境信息与
 * 插件段落一起拼进去，只有发出去的那份才算数。所以这里读会话快照里记下的全文，再按顶层
 * 标签切成几段说明「几十 KB 都花在哪」，全文放在只读编辑器里（可查找、可折叠）。
 */
export function SystemPromptPane({ sessionId, refreshToken }: { sessionId: string; refreshToken: number }) {
  const [data, setData] = useState<ConfigWebSessionPrompt | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    readSessionSystemPrompt(sessionId)
      .then((next) => {
        if (cancelled) return;
        setData(next);
        setError(null);
      })
      .catch((loadError) => {
        if (!cancelled) setError(formatError(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, refreshToken]);

  const prompt = data?.prompt ?? '';
  const parts = useMemo(() => splitPromptSections(prompt), [prompt]);
  const summary = useMemo(() => summarizePrompt(prompt), [prompt]);

  async function copyPrompt() {
    if (!navigator.clipboard?.writeText) {
      setNotice('当前环境不支持自动复制，请手动选择');
      return;
    }
    try {
      await navigator.clipboard.writeText(prompt);
      setNotice('已复制全文');
    } catch {
      setNotice('复制失败，请手动选择');
    }
    window.setTimeout(() => setNotice(null), NOTICE_MS);
  }

  if (loading && !data) return <div className="session-loading">正在读取系统提示词…</div>;
  if (error && !data) return <div className="ui-alert">{error}</div>;
  if (!data) return null;
  if (!prompt) return <PromptMissing rolePrompt={data.rolePrompt} error={error} />;

  return (
    <div className="prompt-pane">
      {error ? <div className="ui-alert">{error}</div> : null}
      <div className="prompt-toolbar">
        <div className="prompt-facts">
          <span>
            <strong>{formatCharCount(summary.chars)}</strong> 字符
          </span>
          <span>
            ≈ <strong>{formatCharCount(summary.tokens)}</strong> tokens
          </span>
          <span>
            <strong>{summary.lines}</strong> 行
          </span>
        </div>
        <div className="prompt-toolbar-actions">
          {notice ? <span className="prompt-notice">{notice}</span> : null}
          <Button onClick={() => void copyPrompt()}>复制全文</Button>
        </div>
      </div>

      {parts.length > 1 ? <PromptParts parts={parts} /> : null}

      <div className="editor-host prompt-editor">
        {/* Markdown 高亮：提示词本身就是 markdown（标题、列表、围栏代码块），外加 <system>
            这类标签——用 plaintext 只能看到一整片同色文字。 */}
        <JsonEditor value={prompt} language="markdown" readOnly onChange={() => undefined} />
      </div>
    </div>
  );
}

/** 构成一览：每段一条，条形按「最大的那一段」归一，只有长度是可比的。 */
function PromptParts({ parts }: { parts: ReturnType<typeof splitPromptSections> }) {
  const longest = Math.max(...parts.map((part) => part.chars), 1);
  const hasGap = parts.some((part) => !part.tag);
  return (
    <section className="prompt-parts">
      <div className="prompt-parts-head">
        <h3>提示词构成</h3>
        <span className="muted-text">
          {hasGap ? '按顶层标签切分，没有标签的插件段落归入「其它注入」' : '按顶层标签切分'}
        </span>
      </div>
      {/* 表头放在滚动区外面：翻到后面那几段时仍然知道两列数字是什么。 */}
      <div className="prompt-part prompt-part-head" aria-hidden="true">
        <span>段落</span>
        <span />
        <span className="prompt-part-size">字符</span>
        <span className="prompt-part-size">≈tokens</span>
      </div>
      <div className="prompt-part-list">
        {parts.map((part, index) => (
          <div className="prompt-part" key={`${part.tag || 'gap'}:${index}`}>
            <span className="prompt-part-label" title={part.label}>
              {part.label}
            </span>
            <span className="prompt-part-track" aria-hidden="true">
              <i style={{ width: `${Math.max((part.chars / longest) * 100, 1.5)}%` }} />
            </span>
            <span className="prompt-part-size">{formatCharCount(part.chars)}</span>
            <span className="prompt-part-size">{formatCharCount(part.tokens)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * 没有记录时的说明。
 *
 * 旧会话的文件里没有提示词，重新拼一遍只会拼出「现在」的样子——那不是当时发出去的内容，
 * 所以宁可说清楚没有，只把角色提示词作为参考摆出来（它只是其中一段）。
 */
function PromptMissing({ rolePrompt, error }: { rolePrompt: string; error: string | null }) {
  return (
    <div className="prompt-empty">
      {error ? <div className="ui-alert">{error}</div> : null}
      <h3>这条会话没有记录系统提示词</h3>
      <p>
        提示词在每次请求时现场拼装：角色提示词、项目说明（AGENT.md）、skills 索引、环境信息，
        再加上插件贡献的段落。Mica 只保留最近一次请求发出去的那一份，这条会话早于这项记录。
      </p>
      <p className="muted-text">在这个会话里发一条消息后再回来，这里就会显示完整内容。</p>
      {rolePrompt ? (
        <details className="prompt-role-fallback">
          <summary>角色提示词（只是其中一段，不是发出去的全部内容）</summary>
          <pre>{rolePrompt}</pre>
        </details>
      ) : null}
    </div>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
