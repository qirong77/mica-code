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
  // -1 是「完整提示词」那一行，其余是 parts 的下标。默认全文：进来先看真正发出去的东西。
  const [selectedPart, setSelectedPart] = useState(-1);
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
  const selected = selectedPart >= 0 ? (parts[selectedPart] ?? parts[0]) : undefined;
  const shownPrompt = selectedPart === -1 ? prompt : (selected?.content ?? prompt);
  const summary = useMemo(() => summarizePrompt(prompt), [prompt]);
  // 工具栏跟着「现在看的是哪一段」走：选了一段却显示全文的体积，读起来就是错的数字。
  const shownStats = useMemo(
    () => (selectedPart === -1 || !selected ? summary : summarizePrompt(selected.content)),
    [selected, selectedPart, summary],
  );

  async function copyPrompt() {
    if (!navigator.clipboard?.writeText) {
      setNotice('当前环境不支持自动复制，请手动选择');
      return;
    }
    try {
      await navigator.clipboard.writeText(shownPrompt);
      setNotice(selectedPart === -1 ? '已复制全文' : '已复制这一段');
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
      <div className="session-pane-toolbar">
        <div className="session-pane-facts">
          <span>
            <strong>{formatCharCount(shownStats.chars)}</strong> 字符
          </span>
          <span>
            ≈ <strong>{formatCharCount(shownStats.tokens)}</strong> tokens
          </span>
          <span>
            <strong>{shownStats.lines}</strong> 行
          </span>
        </div>
        <div className="session-pane-actions">
          {notice ? <span className="session-pane-notice">{notice}</span> : null}
          <Button onClick={() => void copyPrompt()}>{selectedPart === -1 ? '复制全文' : '复制这一段'}</Button>
        </div>
      </div>

      <div className="prompt-body">
        <PromptModules parts={parts} selectedPart={selectedPart} total={summary} onSelect={setSelectedPart} />
        <div className="editor-host prompt-editor">
          {/* Markdown 高亮：提示词本身就是 markdown（标题、列表、围栏代码块），外加 <system>
              这类标签——用 plaintext 只能看到一整片同色文字。 */}
          <JsonEditor value={shownPrompt} language="markdown" readOnly onChange={() => undefined} />
        </div>
      </div>
    </div>
  );
}

/**
 * 模块列表：既是目录也是构成表。
 *
 * 以前这里是「下拉选模块 + 一个按钮在全文/单段之间切换 + 另一个按钮展开构成表」三件控件，
 * 各自都能改变「现在看的是哪一段」，谁也不会把谁的状态带过去。现在只有这一列：首行是全文，
 * 下面每段一行，条形按最大的那一段归一（只有长度可比），点谁就换谁，一份状态。
 */
function PromptModules({
  parts,
  selectedPart,
  total,
  onSelect,
}: {
  parts: ReturnType<typeof splitPromptSections>;
  selectedPart: number;
  total: { chars: number; tokens: number };
  onSelect: (index: number) => void;
}) {
  const longest = Math.max(...parts.map((part) => part.chars), 1);
  return (
    <aside className="prompt-modules" aria-label="提示词模块">
      <div className="prompt-modules-head">
        <span>提示词模块</span>
        <span className="prompt-modules-legend">字符</span>
      </div>
      <div className="prompt-module-list">
        <button
          type="button"
          aria-pressed={selectedPart === -1}
          className={`prompt-module prompt-module-full${selectedPart === -1 ? ' is-selected' : ''}`}
          title={`全文 ${formatCharCount(total.chars)} 字符 ≈${formatCharCount(total.tokens)} tokens`}
          onClick={() => onSelect(-1)}
        >
          <span className="prompt-module-top">
            <span className="prompt-module-label">完整提示词</span>
            <span className="prompt-module-size">{formatCharCount(total.chars)}</span>
          </span>
        </button>
        {parts.map((part, index) => (
          <button
            type="button"
            aria-pressed={selectedPart === index}
            className={`prompt-module${selectedPart === index ? ' is-selected' : ''}`}
            key={`${part.tag || 'gap'}:${index}`}
            title={`${part.tag ? `<${part.tag}> ` : ''}${formatCharCount(part.chars)} 字符 ≈${formatCharCount(part.tokens)} tokens`}
            onClick={() => onSelect(index)}
          >
            <span className="prompt-module-top">
              <span className="prompt-module-label">{part.label}</span>
              <span className="prompt-module-size">{formatCharCount(part.chars)}</span>
            </span>
            <span className="prompt-module-track" aria-hidden="true">
              <i style={{ width: `${Math.max((part.chars / longest) * 100, 1.5)}%` }} />
            </span>
          </button>
        ))}
      </div>
    </aside>
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
        提示词在每次请求时现场拼装：角色提示词、项目说明（AGENT.md）、skills 索引、环境信息， 再加上插件贡献的段落。Mica
        只保留最近一次请求发出去的那一份，这条会话早于这项记录。
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
