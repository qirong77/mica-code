import { useCallback, useEffect, useState } from 'react';
import { ControlEndpointList } from '../components/ControlEndpointList.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import {
  TERMINAL_CONTROL_DISABLED_STEPS,
  TERMINAL_URL_ENV_FALLBACK,
  sessionStatusLabel,
  sessionTitle,
  sessionWindowLabel,
  terminalCurlExample,
  terminalEnvHint,
} from '../terminalControl.js';
import { readTerminalControlDetails } from '../api.js';
import type { ConfigWebBrowserControlEndpoint, ConfigWebTerminalControlDetails } from '../../src/shared/types.js';

/**
 * Terminal Control：Mica 里那套**给 AI 用的**终端。
 *
 * 每个会话都是真实 PTY + 登录 shell（见 `apps/desktop/src/main/terminal/`），窗口以一张
 * 后台页面挂在应用里；agent 经本机 HTTP 接口读屏、输入、等输出。这一页与 Browser Control
 * 同一条边界：**只管展示**，会话由 agent 调接口创建，窗口的开 / 隐藏 / 关闭由 agent 与主区
 * 顶栏图标完成。
 *
 * 入口各处都在（见 `layout/Sidebar.tsx`）：拿不到服务时用
 * `unavailableTerminalControlDetails` 的详情说清「未开启、为什么、怎么开」，藏起入口反而
 * 让人以为 Mica 没有这个能力。
 */
export function TerminalControlPage() {
  const [details, setDetails] = useState<ConfigWebTerminalControlDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const RefreshIcon = appIcons.refresh;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetails(await readTerminalControlDetails());
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 会话是 agent 在别处开的，这一页停在原地时列表会停在打开那一刻的快照。
  // 只在这一节被渲染时轮询，页面不可见时跳过（后台标签页不打扰运行时）。
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void readTerminalControlDetails()
        .then(setDetails)
        .catch(() => {
          // 轮询失败不改界面状态：上一次的结果仍然是有意义的（错误由主动刷新显示）
        });
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 1800);
  }, []);

  async function copy(text: string) {
    if (!navigator.clipboard?.writeText) {
      flash('当前环境不支持自动复制，请手动选择');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      flash('已复制');
    } catch {
      flash('复制失败，请手动选择');
    }
  }

  const exampleBase = details?.envVars?.url ? `$${details.envVars.url}` : TERMINAL_URL_ENV_FALLBACK;
  const exampleFor = useCallback(
    (endpoint: ConfigWebBrowserControlEndpoint) => terminalCurlExample(endpoint, exampleBase),
    [exampleBase],
  );

  return (
    <PageFrame
      title="Terminal Control"
      description="Mica 内置终端：一个会话一个后台 shell，agent 读写它看到的那一屏"
      path={details?.serviceUrl ?? undefined}
      actions={
        <div className="toolbar">
          {notice ? <span className="save-status">{notice}</span> : null}
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={() => void load()} loading={loading} />
        </div>
      }
    >
      <div className="detail-body detail-body-stacked">
        {error ? <Alert message={error} /> : null}
        {loading && !details ? (
          <div className="page-loading">正在加载终端服务…</div>
        ) : !details ? null : (
          <div className="control-stack">
            <section className="simple-card control-card">
              <header className="control-head">
                <div className="control-head-copy">
                  <h2>服务状态</h2>
                  <p>Mica 终端：每个会话都是真实 PTY，agent 用一套本机 HTTP 接口读屏、输入与等待输出。</p>
                </div>
                <Tag tone={details.available ? 'green' : 'red'} dot>
                  {details.available ? '可用' : '不可用'}
                </Tag>
              </header>

              <dl className="control-facts">
                <Fact label="服务地址" value={details.serviceUrl || '—'} mono />
                <Fact label="版本" value={details.version ? `v${details.version}` : '—'} />
                <Fact label="会话" value={String(details.sessions.length)} />
                <Fact label="MCP 端点" value={details.mcpUrl || '—'} mono />
                <Fact label="工具名" value={details.toolName || 'control'} mono />
              </dl>

              {details.mcpUrl ? (
                <p className="control-note">
                  agent 通过 MCP 使用这个能力：会话启动时带一份只含这个端点的 <code>--mcp-config</code>，工具{' '}
                  <code>{details.toolName}</code> 不带参数调用会返回 全部操作的文档，带 <code>action</code> 再执行。
                </p>
              ) : null}

              {!details.available ? (
                <ul className="control-steps">
                  {TERMINAL_CONTROL_DISABLED_STEPS.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              ) : null}

              <p className="control-note">{terminalEnvHint(details.envVars)}</p>
            </section>

            <section className="simple-card control-card">
              <header className="control-head">
                <div className="control-head-copy">
                  <h2>终端会话</h2>
                  <p>关掉窗口不会杀掉 shell：会话继续在后台跑，AI 随时可以回来接着读。</p>
                </div>
                <span className="control-head-count">{details.sessions.length} 个</span>
              </header>

              {details.sessions.length === 0 ? (
                <Empty
                  description={
                    details.available
                      ? '还没有终端会话（agent 调 POST /sessions 开一个）'
                      : '暂无终端会话（需要终端服务在线）'
                  }
                />
              ) : (
                <div className="control-sessions">
                  {details.sessions.map((session) => (
                    <div className="control-session" key={session.id}>
                      <div className="control-session-main">
                        <span className="control-session-title" title={sessionTitle(session)}>
                          {sessionTitle(session)}
                        </span>
                        <span className="control-session-meta">
                          {session.cols}×{session.rows} · {session.shell || 'shell'} ·{' '}
                          {session.owner ? `归属 ${session.owner}` : '无归属'}
                        </span>
                      </div>
                      <div className="control-session-tags">
                        <Tag tone={session.running ? 'green' : 'red'} dot>
                          {sessionStatusLabel(session)}
                        </Tag>
                        <Tag tone="blue">{sessionWindowLabel(session)}</Tag>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <p className="control-note">
                归属：agent 用 <code>x-mica-owner</code> 头声明归属，写操作只允许归属者执行； 其他会话能看、不能敲。
              </p>
            </section>

            <section className="simple-card control-card">
              <header className="control-head">
                <div className="control-head-copy">
                  <h2>接口文档</h2>
                  <p>agent 直接调用这些接口；展开后可以复制 curl 示例。</p>
                </div>
              </header>
              <ControlEndpointList
                endpoints={details.endpoints}
                exampleFor={exampleFor}
                emptyDescription="暂无接口文档（需要终端服务在线）"
                onCopy={(text) => void copy(text)}
              />
            </section>
          </div>
        )}
      </div>
    </PageFrame>
  );
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="control-fact">
      <dt>{label}</dt>
      <dd className={mono ? 'control-fact-mono' : undefined} title={value}>
        {value}
      </dd>
    </div>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
