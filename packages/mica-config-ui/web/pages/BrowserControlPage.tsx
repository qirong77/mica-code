import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Tag } from '../components/Ui.js';
import { appIcons } from '../icons.js';
import {
  BROWSER_CONTROL_DISABLED_STEPS,
  BROWSER_URL_ENV_FALLBACK,
  browserEnvHint,
  curlExample,
  endpointSummaryLine,
  groupEndpoints,
} from '../browserControl.js';
import { readBrowserControlDetails } from '../api.js';
import type { ConfigWebBrowserControlDetails } from '../../src/shared/types.js';

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
 * 写给 agent 的技能文档不在这里展开——它由应用生成并同步到技能文件，正文只指向接口文档。
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

  const groups = useMemo(() => groupEndpoints(details?.endpoints), [details]);
  const exampleBase = details?.envVars?.url ? `$${details.envVars.url}` : BROWSER_URL_ENV_FALLBACK;

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
              <div className="control-card-head">
                <div className="table-panel-title">
                  <strong>服务状态</strong>
                  <span>Mica 受控浏览器：窗口挂在应用里，agent 用一套本机 HTTP 接口来开、读与操控。</span>
                </div>
                <Tag tone={details.available ? 'green' : 'red'} dot>
                  {details.available ? '可用' : '不可用'}
                </Tag>
              </div>

              <div className="status-grid">
                <StatusItem label="服务地址" value={details.serviceUrl || '—'} mono />
                <StatusItem label="版本" value={details.version ? `v${details.version}` : '—'} mono />
                <StatusItem label="窗口数" value={String(details.browsers.length)} mono />
                <StatusItem label="技能文件" value={details.skillPath || '—'} mono />
              </div>

              {details.skillPath ? (
                <p className="control-note">
                  技能文件是写给 agent 的 <code>SKILL.md</code>：告诉它这台机器上有一套能真正打开的浏览器、
                  并指向下面的接口文档。
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
              <div className="control-card-head">
                <div className="table-panel-title">
                  <strong>接口文档</strong>
                  <span>agent 直接调用这些接口；窗口本身不会改地址，下文的 curl 示例可以直接复制。</span>
                </div>
              </div>

              {groups.length === 0 ? (
                <Empty description="暂无接口文档（需要受控浏览器服务在线）" />
              ) : (
                <div className="control-groups">
                  {groups.map((group) => (
                    <div className="control-group" key={group.method}>
                      <div className="control-group-head">
                        <Tag tone="blue">{group.label}</Tag>
                        <span className="muted-text">{group.endpoints.length} 个接口</span>
                      </div>
                      <div className="control-endpoint-list">
                        {group.endpoints.map((endpoint) => (
                          <details className="simple-card control-endpoint" key={endpoint.id}>
                            <summary className="control-endpoint-summary">
                              <code className="control-endpoint-line">{endpointSummaryLine(endpoint)}</code>
                              <span className="control-endpoint-desc">{endpoint.summary}</span>
                            </summary>
                            <div className="control-endpoint-body">
                              {endpoint.params.length === 0 ? (
                                <p className="muted-text">无参数</p>
                              ) : (
                                <div className="control-params">
                                  {endpoint.params.map((param) => (
                                    <div className="control-param" key={`${param.in}:${param.name}`}>
                                      <code>{param.name}</code>
                                      <span className="control-param-meta">
                                        {param.in}
                                        {param.required ? ' · 必填' : ''}
                                      </span>
                                      <span className="control-param-desc">{param.description}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {endpoint.returns ? (
                                <p className="control-returns">
                                  <span className="muted-text">返回</span> {endpoint.returns}
                                </p>
                              ) : null}
                              <div className="control-example">
                                <div className="control-example-head">
                                  <span className="muted-text">示例</span>
                                  <Button
                                    onClick={() => void copy(endpoint.example || curlExample(endpoint, exampleBase))}
                                  >
                                    复制
                                  </Button>
                                </div>
                                <pre className="code-preview">
                                  {endpoint.example || curlExample(endpoint, exampleBase)}
                                </pre>
                              </div>
                            </div>
                          </details>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </PageFrame>
  );
}

function StatusItem({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="status-item">
      <span className="status-label">{label}</span>
      <span className={`control-status-value${mono ? ' status-code' : ''}`} title={value}>
        {value}
      </span>
    </div>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
