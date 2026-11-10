import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { readSessionSystemPrompt } from '../api.js';
import { JsonEditor } from './JsonEditor.js';
import { Button, Tag } from './Ui.js';
import { Input } from './ArcoSettings.js';
import { formatCharCount } from '../format.js';
import {
  analyzePrompt,
  findPromptNode,
  promptNodePath,
  promptShareWeights,
  searchPrompt,
  type PromptNode,
} from '../promptView.js';
import type { ConfigWebSessionPrompt } from '../../src/shared/types.js';

const NOTICE_MS = 1800;

/**
 * 系统提示词：这条会话最近一次请求**真正发出去**的那一份。
 *
 * 它不是角色文件里那一段：`buildSystemPrompt()` 会把 AGENT.md、skills 索引、环境信息与
 * 插件段落一起拼进去，只有发出去的那份才算数。所以这里读会话快照里记下的全文。
 *
 * 界面分两栏：左边是「段 → markdown 标题」的大纲，每行带着它占全文多少；右边是所选模块的
 * 正文。几十 KB 的东西不能只切成四块丢进编辑器——那样只能通读，没法回答「哪一节在吃预算」
 * 「这段说明写在哪」。搜索按节点正文过滤大纲，并在行尾给出命中次数。
 */
export function SystemPromptPane({
  sessionId,
  refreshToken,
  contextWindowSize,
}: {
  sessionId: string;
  refreshToken: number;
  contextWindowSize?: number;
}) {
  const [data, setData] = useState<ConfigWebSessionPrompt | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [sortBySize, setSortBySize] = useState(false);
  const [fullView, setFullView] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);
  const [revealNonce, setRevealNonce] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);

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

  // 提示词变了（这一轮跑完 / 换了角色）就回到最新一份的大纲：旧的展开状态指的是另一份文本。
  const prompt = data?.prompt ?? '';
  const promptRef = useRef(prompt);
  useEffect(() => {
    if (promptRef.current === prompt) return;
    promptRef.current = prompt;
    setSelectedId(null);
    setToggled({});
    setFullView(false);
    setRevealNonce((value) => value + 1);
  }, [prompt]);

  useEffect(() => {
    return () => {
      if (noticeTimer.current !== undefined) window.clearTimeout(noticeTimer.current);
    };
  }, []);

  const outline = useMemo(() => analyzePrompt(prompt), [prompt]);
  const searching = query.trim().length > 0;
  const search = useMemo(() => (searching ? searchPrompt(outline.nodes, query) : null), [outline, query, searching]);
  const rows = useMemo(() => {
    const base = search ? search.nodes : outline.nodes;
    if (!sortBySize || searching) return base;
    return sortBySizeTree(base);
  }, [outline, search, sortBySize, searching]);
  const selected = useMemo(
    () => findPromptNode(outline.nodes, selectedId) ?? outline.nodes[0] ?? null,
    [outline, selectedId],
  );
  const path = useMemo(() => promptNodePath(outline.nodes, selected?.id ?? null), [outline, selected]);

  // 搜索时详情跟着跳到第一个命中：否则出现「命中的行在左栏亮着、右栏还是上一段」。
  useEffect(() => {
    if (!search || search.nodes.length === 0) return;
    if ((search.hits.get(selectedId ?? '') ?? 0) > 0) return;
    const first = firstHitNode(search.nodes, search.hits);
    if (first) select(first);
  }, [search, selectedId]);

  // 搜索命中的就是「要看的那几节」：过滤后一律展开，不用再一个个点开找。
  function isOpen(node: PromptNode) {
    if (searching || sortBySize) return true;
    const explicit = toggled[node.id];
    if (explicit !== undefined) return explicit;
    return node.level <= 1;
  }

  function select(node: PromptNode | null) {
    if (!node) return;
    setSelectedId(node.id);
    if (fullView) setRevealNonce((value) => value + 1);
  }

  function toggle(node: PromptNode) {
    const next = !isOpen(node);
    setToggled((current) => ({ ...current, [node.id]: next }));
  }

  function flash(message: string) {
    setNotice(message);
    if (noticeTimer.current !== undefined) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }

  async function copyText(text: string, label: string) {
    if (!text) return;
    if (!navigator.clipboard?.writeText) {
      flash('当前环境不支持自动复制，请手动选择');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      flash(`已复制${label}`);
    } catch {
      flash('复制失败，请手动选择');
    }
  }

  if (loading && !data) return <div className="session-loading">正在读取系统提示词…</div>;
  if (error && !data) return <div className="ui-alert">{error}</div>;
  if (!data) return null;
  if (!prompt) return <PromptMissing rolePrompt={data.rolePrompt} error={error} />;

  const summary = outline.summary;
  const totalChars = Math.max(summary.chars, 1);
  const windowShare = contextWindowSize && contextWindowSize > 0 ? summary.tokens / contextWindowSize : null;
  const shownText = fullView ? prompt : (selected?.content ?? prompt);
  const revealLine = fullView ? (selected?.startLine ?? null) : null;

  function renderRows(nodes: PromptNode[], depth: number): ReactNode {
    return nodes.map((node) => {
      const open = isOpen(node);
      const hits = search?.hits.get(node.id) ?? 0;
      const active = selected?.id === node.id;
      return (
        <div key={node.id} className="prompt-row-group" role="group">
          <div
            className={`prompt-row${active ? ' is-selected' : ''}`}
            style={{ '--prompt-depth': depth } as CSSProperties}
            role="treeitem"
            aria-selected={active}
            aria-expanded={node.children.length > 0 ? open : undefined}
          >
            <i
              className="prompt-row-fill"
              style={{ width: `${Math.min(100, Math.max((node.chars / totalChars) * 100, 0.8))}%` }}
              aria-hidden="true"
            />
            {node.children.length > 0 ? (
              <button
                type="button"
                className="prompt-row-toggle"
                title={open ? '收起子节' : '展开子节'}
                aria-label={open ? '收起子节' : '展开子节'}
                onClick={() => toggle(node)}
              >
                <span className={`prompt-caret${open ? ' is-open' : ''}`} aria-hidden="true" />
              </button>
            ) : (
              <span className="prompt-row-toggle" aria-hidden="true" />
            )}
            <button
              type="button"
              className="prompt-row-main"
              aria-current={active ? 'true' : undefined}
              onClick={() => select(node)}
            >
              <span className="prompt-row-label" title={node.label}>
                {node.label}
              </span>
              {hits > 0 ? <span className="prompt-row-hit">{hits}</span> : null}
              <span className="prompt-row-size">{formatCharCount(node.chars)}</span>
              <span className="prompt-row-share">{formatShare(node.chars, totalChars)}</span>
            </button>
          </div>
          {open && node.children.length > 0 ? renderRows(node.children, depth + 1) : null}
        </div>
      );
    });
  }

  return (
    <div className="prompt-pane">
      {error ? <div className="ui-alert">{error}</div> : null}

      <div className="session-pane-toolbar">
        <div className="session-pane-facts">
          <span>
            <strong>{formatCharCount(summary.chars)}</strong> 字符
          </span>
          <span>
            ≈ <strong>{formatCharCount(summary.tokens)}</strong> tokens
          </span>
          <span>
            <strong>{summary.lines}</strong> 行
          </span>
          {windowShare !== null ? (
            <span title={`最近一次记录的 context window：${contextWindowSize!.toLocaleString()} tokens`}>
              占窗口 <strong>{formatPercent(windowShare)}</strong>
            </span>
          ) : null}
        </div>
        <div className="session-pane-actions">
          {notice ? <span className="session-pane-notice">{notice}</span> : null}
          <Button variant="ghost" pressed={scopeOpen} onClick={() => setScopeOpen((value) => !value)}>
            口径
          </Button>
          <Button onClick={() => void copyText(prompt, '全文')}>复制全文</Button>
        </div>
      </div>

      {scopeOpen ? (
        <p className="prompt-scope">
          这里只算 system prompt 本身：默认正文、追加 Role、AGENT.md、skills 索引、环境信息与插件段落。 工具
          schema、消息历史与思考内容不在其中（它们在「Context 分析」页计入未解释的开销）。 tokens 按字符粗估（CJK 按
          1、其余按 1/4），与状态栏的 ctx 同一口径。
        </p>
      ) : null}

      {outline.nodes.length > 0 ? (
        <PromptShareBar nodes={outline.nodes} total={totalChars} selectedId={selected?.id ?? null} onSelect={select} />
      ) : null}

      <div className="prompt-body">
        <aside className="prompt-rail" aria-label="提示词大纲">
          <div className="prompt-rail-head">
            <Input
              className="prompt-search"
              type="search"
              value={query}
              placeholder="搜索标题与正文…"
              aria-label="搜索系统提示词"
              onChange={setQuery}
            />
            <Button
              variant="ghost"
              pressed={sortBySize}
              title={sortBySize ? '回到文档顺序' : '同一层内按体积从大到小排列'}
              onClick={() => setSortBySize((value) => !value)}
            >
              按体积
            </Button>
          </div>
          <div className="prompt-rail-meta">
            {searching ? (
              <span>
                命中 <strong>{search?.total ?? 0}</strong> 处
              </span>
            ) : (
              <span>{outline.nodes.length} 个模块</span>
            )}
            {searching && (search?.total ?? 0) === 0 ? <span className="muted-text">没有匹配的内容</span> : null}
          </div>

          <div className="prompt-tree" role="tree" aria-label="提示词模块">
            {rows.length === 0 ? (
              <p className="prompt-tree-empty">没有匹配的模块。换个关键词，或清空搜索查看全部。</p>
            ) : (
              renderRows(rows, 0)
            )}
          </div>
        </aside>

        <section className="prompt-detail">
          <div className="prompt-detail-head">
            <div className="prompt-crumbs" title={path.map((node) => node.label).join(' › ')}>
              {path.map((node, index) => {
                const current = index === path.length - 1;
                return (
                  <span key={node.id} className="prompt-crumb-item">
                    {index > 0 ? (
                      <span className="prompt-crumb-sep" aria-hidden="true">
                        ›
                      </span>
                    ) : null}
                    {current ? (
                      <span className="prompt-crumb is-current">{node.label}</span>
                    ) : (
                      <button type="button" className="prompt-crumb" onClick={() => select(node)}>
                        {node.label}
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
            <div className="prompt-detail-actions">
              <Button variant="ghost" onClick={() => void copyText(shownText, fullView ? '全文' : '本节')}>
                {fullView ? '复制全文' : '复制本节'}
              </Button>
              <Button variant="ghost" pressed={fullView} onClick={() => setFullView((value) => !value)}>
                {fullView ? '只看本节' : '查看全文'}
              </Button>
            </div>
          </div>

          <div className="prompt-detail-meta">
            {selected ? (
              <>
                <span className="prompt-line-range">
                  第 {selected.startLine}
                  {selected.endLine > selected.startLine ? `–${selected.endLine}` : ''} 行
                </span>
                <span>{formatCharCount(selected.chars)} 字符</span>
                <span>≈ {formatCharCount(selected.tokens)} tokens</span>
                <span className="muted-text">占全文 {formatShare(selected.chars, totalChars)}</span>
                {selected.children.length > 0 ? <Tag>{selected.children.length} 个子节</Tag> : null}
              </>
            ) : null}
            {fullView ? <span className="muted-text">全文 {summary.lines} 行</span> : null}
          </div>

          <div className="editor-host prompt-editor">
            {/* Markdown 高亮：提示词本身就是 markdown（标题、列表、围栏代码块），外加 <system>
                这类标签——用 plaintext 只能看到一整片同色文字。 */}
            <JsonEditor
              value={shownText}
              language="markdown"
              readOnly
              reveal={revealLine ? { line: revealLine, nonce: revealNonce } : null}
              onChange={() => undefined}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

/** 构成一览：一条堆叠条，按「占全文的比例」分配宽度，点一格就是选中那一段。 */
function PromptShareBar({
  nodes,
  total,
  selectedId,
  onSelect,
}: {
  nodes: PromptNode[];
  total: number;
  selectedId: string | null;
  onSelect: (node: PromptNode) => void;
}) {
  if (nodes.length < 2) return null;
  const weights = promptShareWeights(
    nodes.map((node) => node.chars),
    total,
  );
  return (
    <div className="prompt-share" role="group" aria-label="各模块占全文的比例">
      {nodes.map((node, index) => (
        <button
          key={node.id}
          type="button"
          className={`prompt-share-seg prompt-share-${index % 5}${selectedId === node.id ? ' is-selected' : ''}`}
          style={{ flexGrow: weights[index] ?? 1, flexBasis: 0 }}
          title={`${node.label} · ${formatCharCount(node.chars)} 字符 · ${formatShare(node.chars, total)} · 点击查看这一节`}
          aria-label={`${node.label}，${formatShare(node.chars, total)}`}
          onClick={() => onSelect(node)}
        />
      ))}
    </div>
  );
}

/**
 * 没有记录时的说明。
 *
 * 旧会话的文件里没有提示词，重新拼一遍只会拼出「现在」的样子——那不是当时发出去的内容，
 * 所以宁可说清楚没有，只把当前默认正文与追加 Role 作为参考摆出来。
 */
function PromptMissing({ rolePrompt, error }: { rolePrompt: string; error: string | null }) {
  return (
    <div className="prompt-empty">
      {error ? <div className="ui-alert">{error}</div> : null}
      <h3>这条会话没有记录系统提示词</h3>
      <p>
        提示词在每次请求时现场拼装：默认正文、追加 Role、项目说明（AGENT.md）、skills 索引、环境信息，
        再加上插件贡献的段落。Mica 只保留最近一次请求发出去的那一份，这条会话早于这项记录。
      </p>
      <p className="muted-text">在这个会话里发一条消息后再回来，这里就会显示完整内容。</p>
      {rolePrompt ? (
        <details className="prompt-role-fallback">
          <summary>当前默认正文与追加 Role（仅供参考，不是当时发出的完整提示词）</summary>
          <pre>{rolePrompt}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** 搜索树上第一个自己命中的节点：输入关键词时详情落到它身上。 */
function firstHitNode(nodes: PromptNode[], hits: Map<string, number>): PromptNode | null {
  for (const node of nodes) {
    if ((hits.get(node.id) ?? 0) > 0) return node;
    const child = firstHitNode(node.children, hits);
    if (child) return child;
  }
  return null;
}

function formatShare(chars: number, total: number): string {
  return total ? formatPercent(chars / total) : '—';
}

function formatPercent(ratio: number): string {
  const percent = ratio * 100;
  if (percent > 0 && percent < 0.1) return '<0.1%';
  if (percent < 10) return `${percent.toFixed(1)}%`;
  return `${Math.round(percent)}%`;
}

/** 按体积重排时只在同一层内换位置：父节仍然包着自己的子节，大纲结构不变。 */
function sortBySizeTree(nodes: PromptNode[]): PromptNode[] {
  return [...nodes]
    .sort((left, right) => right.chars - left.chars)
    .map((node) => (node.children.length > 0 ? { ...node, children: sortBySizeTree(node.children) } : node));
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
