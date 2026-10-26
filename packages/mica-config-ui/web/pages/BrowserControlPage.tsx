import { useCallback, useEffect, useState } from 'react';
import { ControlEndpointList } from '../components/ControlEndpointList.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import {
  BROWSER_CONTROL_DISABLED_STEPS,
  BROWSER_URL_ENV_FALLBACK,
  browserEnvHint,
  curlExample,
} from '../browserControl.js';
import { readBrowserControlDetails } from '../api.js';
import type { ConfigWebBrowserControlDetails, ConfigWebBrowserControlEndpoint } from '../../src/shared/types.js';

/**
 * Browser Control：Mica 里那套**给 AI 用的**受控浏览器。
 *
 * 窗口活在 Electron 主进程、agent 经本机 HTTP 服务操控它们（见
 * `apps/desktop/src/host/browser-control.js`）。这一节的入口**各处都在**：拿不到服务时
 * 页面自己说清楚「未开启、为什么、怎么开」（见 `browserControl.ts` 的
 * `unavailableBrowserControlDetails`），藏起入口反而让人以为 Mica 没有这个能力。
 *
 * 这一页**不管窗口**：开、显示、隐藏、关闭分别由 agent 调接口与主区顶栏的图标完成，列在这里
 * 只会让人以为得手动建。它只讲服务状态与接口文档，展示口径全在 `browserControl.ts`。
 * agent 侧接入是 MCP（`/mcp/browser`，单工具 `control`）：端点与会话里是怎么带的见页面正文。
 */
export function BrowserControlPage() {
  const [details, setDetails] = useState<ConfigWebBrowserControlDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const RefreshIcon = appIcons.refresh;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDetails(await readBrowserControlDetails());
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 窗口是 agent 在别处开的，这一页停在原地时「可用 / 窗口数」会停在打开那一刻的快照。
  // 只在这一节被渲染时轮询，页面不可见时跳过（后台标签页不打扰运行时）。
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void readBrowserControlDetails()
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

  const exampleBase = details?.envVars?.url ? `$${details.envVars.url}` : BROWSER_URL_ENV_FALLBACK;
  const exampleFor = useCallback(
    (endpoint: ConfigWebBrowserControlEndpoint) => curlExample(endpoint, exampleBase),
    [exampleBase],
  );

  return (
    <PageFrame
      title="Browser Control"
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
          <div className="page-loading">正在加载受控浏览器…</div>
        ) : !details ? null : (
          <div className="control-stack">
            <section className="simple-card control-card">
              <header className="control-head">
                <div className="control-head-copy">
                  <h2>服务状态</h2>
                  <p>Mica 受控浏览器：窗口挂在应用里，agent 用一套本机 HTTP 接口来开、读与操控。</p>
                </div>
                <Tag tone={details.available ? 'green' : 'red'} dot>
                  {details.available ? '可用' : '不可用'}
                </Tag>
              </header>

              <dl className="control-facts">
                <Fact label="服务地址" value={details.serviceUrl || '—'} mono />
                <Fact label="版本" value={details.version ? `v${details.version}` : '—'} />
                <Fact label="窗口" value={String(details.browsers.length)} />
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
                  {BROWSER_CONTROL_DISABLED_STEPS.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              ) : null}

              <p className="control-note">{browserEnvHint(details.envVars)}</p>
            </section>

            <section className="simple-card control-card">
              <header className="control-head">
                <div className="control-head-copy">
                  <h2>接口文档</h2>
                  <p>MCP 工具背后的同源端点，排查时可以直接跑；展开后可以复制 curl 示例。</p>
                </div>
              </header>
              <ControlEndpointList
                endpoints={details.endpoints}
                exampleFor={exampleFor}
                emptyDescription="暂无接口文档（需要受控浏览器服务在线）"
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
