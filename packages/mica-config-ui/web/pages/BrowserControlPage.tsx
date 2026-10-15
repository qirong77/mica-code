import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, Empty, Tag } from '../components/Ui.js';
import { confirmDialog } from '../components/DialogHost.js';
import { appIcons } from '../icons.js';
import {
  BROWSER_CONTROL_DISABLED_STEPS,
  BROWSER_URL_ENV_FALLBACK,
  browserEnvHint,
  browserStatusLabel,
  browserStatusTone,
  curlExample,
  endpointSummaryLine,
  groupEndpoints,
  ownerLabel,
  tabSummary,
} from '../browserControl.js';
import {
  closeBrowserControlWindow,
  createBrowserControlWindow,
  hideBrowserControlWindow,
  readBrowserControlDetails,
  showBrowserControlWindow,
} from '../api.js';
import type { ConfigWebBrowserControlBrowser, ConfigWebBrowserControlDetails } from '../../src/shared/types.js';

/**
 * Browser Control：Mica 里那套**给 AI 用的**受控浏览器。
 *
 * 窗口活在 Electron 主进程、agent 经本机 HTTP 服务操控它们（见
 * `apps/desktop/src/host/browser-control.js`）。这一节的入口**各处都在**：拿不到服务时
 * 页面自己说清楚「未开启、为什么、怎么开」（见 `browserControl.ts` 的
 * `unavailableBrowserControlDetails`），藏起入口反而让人以为 Mica 没有这个能力。
 * 页面是只读视图：能显示 / 隐藏 / 关闭窗口，但改不了窗口地址 —— 那由 agent 调用接口完成。
 * 展示口径全在 `browserControl.ts`。
 */
export function BrowserControlPage() {
  const [details, setDetails] = useState<ConfigWebBrowserControlDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [urlDraft, setUrlDraft] = useState('');
  const RefreshIcon = appIcons.refresh;
  const AddIcon = appIcons.add;

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

  // 窗口是 agent 在别处开的，这一页停在原地就要能看见它们出现/消失，否则「窗口数」会一直是
  // 打开页面那一刻的快照。只在这一节被渲染时轮询，页面不可见时跳过（后台标签页不打扰运行时）。
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden || busy) return;
      void readBrowserControlDetails()
        .then(setDetails)
        .catch(() => {
          // 轮询失败不改界面状态：上一次的结果仍然是有意义的（错误由主动刷新显示）
        });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 1800);
  }, []);

  async function runWindowAction(id: string, action: () => Promise<ConfigWebBrowserControlDetails>) {
    setBusy(id);
    setError(null);
    try {
      setDetails(await action());
    } catch (actionError) {
      setError(formatError(actionError));
    } finally {
      setBusy(null);
    }
  }

  async function createWindow() {
    setBusy('create');
    setError(null);
    try {
      setDetails(await createBrowserControlWindow({ url: urlDraft.trim() }));
      setUrlDraft('');
    } catch (createError) {
      setError(formatError(createError));
    } finally {
      setBusy(null);
    }
  }

  async function closeWindow(browser: ConfigWebBrowserControlBrowser) {
    const confirmed = await confirmDialog({
      title: `关闭窗口「${browser.label || browser.id}」`,
      message: '这个窗口会被关闭，它上面的标签页一并消失。此操作不可撤销。',
      confirmText: '关闭窗口',
      danger: true,
    });
    if (!confirmed) return;
    await runWindowAction(browser.id, () => closeBrowserControlWindow({ id: browser.id }));
  }

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
          <div className="browser-control-stack">
            <section className="simple-card browser-control-card">
              <div className="browser-control-card-head">
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
                <p className="browser-control-note">
                  技能文件是写给 agent 的 <code>SKILL.md</code>：告诉它这台机器上有一套能真正打开的浏览器、
                  以及怎么把窗口挂到当前会话上。
                </p>
              ) : null}

              {!details.available ? (
                <ul className="browser-control-steps">
                  {BROWSER_CONTROL_DISABLED_STEPS.map((step) => (
                    <li key={step}>{step}</li>
                  ))}
                </ul>
              ) : null}

              <p className="browser-control-note">{browserEnvHint(details.envVars)}</p>
            </section>

            <section className="simple-card browser-control-card">
              <div className="browser-control-card-head">
                <div className="table-panel-title">
                  <strong>窗口</strong>
                  <span>这是给 AI 用的浏览器；这里只能显示 / 隐藏 / 关闭，地址由 agent 通过接口设置。</span>
                </div>
                <div className="browser-control-create">
                  <input
                    className="text-input"
                    value={urlDraft}
                    placeholder="起始 URL（可留空）"
                    disabled={!details.available || busy === 'create'}
                    onChange={(event) => setUrlDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || !details.available) return;
                      event.preventDefault();
                      void createWindow();
                    }}
                  />
                  <Button
                    icon={<AddIcon size={15} />}
                    onClick={() => void createWindow()}
                    loading={busy === 'create'}
                    disabled={!details.available}
                  >
                    新建窗口
                  </Button>
                </div>
              </div>

              {details.browsers.length === 0 ? (
                <Empty description="还没有受控浏览器窗口" />
              ) : (
                <div className="browser-control-window-list">
                  {details.browsers.map((browser) => (
                    <WindowRow
                      key={browser.id}
                      browser={browser}
                      busy={busy === browser.id}
                      disabled={busy !== null}
                      onShow={() =>
                        void runWindowAction(browser.id, () => showBrowserControlWindow({ id: browser.id }))
                      }
                      onHide={() =>
                        void runWindowAction(browser.id, () => hideBrowserControlWindow({ id: browser.id }))
                      }
                      onClose={() => void closeWindow(browser)}
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="simple-card browser-control-card">
              <div className="browser-control-card-head">
                <div className="table-panel-title">
                  <strong>接口文档</strong>
                  <span>agent 直接调用这些接口；窗口本身不会改地址，下文的 curl 示例可以直接复制。</span>
                </div>
              </div>

              {groups.length === 0 ? (
                <Empty description="暂无接口文档（需要受控浏览器服务在线）" />
              ) : (
                <div className="browser-control-groups">
                  {groups.map((group) => (
                    <div className="browser-control-group" key={group.method}>
                      <div className="browser-control-group-head">
                        <Tag tone="blue">{group.label}</Tag>
                        <span className="muted-text">{group.endpoints.length} 个接口</span>
                      </div>
                      <div className="browser-control-endpoint-list">
                        {group.endpoints.map((endpoint) => (
                          <details className="simple-card browser-control-endpoint" key={endpoint.id}>
                            <summary className="browser-control-endpoint-summary">
                              <code className="browser-control-endpoint-line">{endpointSummaryLine(endpoint)}</code>
                              <span className="browser-control-endpoint-desc">{endpoint.summary}</span>
                            </summary>
                            <div className="browser-control-endpoint-body">
                              {endpoint.params.length === 0 ? (
                                <p className="muted-text">无参数</p>
                              ) : (
                                <div className="browser-control-params">
                                  {endpoint.params.map((param) => (
                                    <div className="browser-control-param" key={`${param.in}:${param.name}`}>
                                      <code>{param.name}</code>
                                      <span className="browser-control-param-meta">
                                        {param.in}
                                        {param.required ? ' · 必填' : ''}
                                      </span>
                                      <span className="browser-control-param-desc">{param.description}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {endpoint.returns ? (
                                <p className="browser-control-returns">
                                  <span className="muted-text">返回</span> {endpoint.returns}
                                </p>
                              ) : null}
                              <div className="browser-control-example">
                                <div className="browser-control-example-head">
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
      <span className={`browser-control-status-value${mono ? ' status-code' : ''}`} title={value}>
        {value}
      </span>
    </div>
  );
}

function WindowRow({
  browser,
  busy,
  disabled,
  onShow,
  onHide,
  onClose,
}: {
  browser: ConfigWebBrowserControlBrowser;
  busy: boolean;
  disabled: boolean;
  onShow(): void;
  onHide(): void;
  onClose(): void;
}) {
  const ShowIcon = appIcons.show;
  const HideIcon = appIcons.hide;
  const CloseIcon = appIcons.close;
  return (
    <div className="browser-control-window">
      <div className="browser-control-window-copy">
        <div className="browser-control-window-title">
          <strong title={browser.id}>{browser.label || browser.id}</strong>
          <Tag tone={browserStatusTone(browser)}>{browserStatusLabel(browser)}</Tag>
          <Tag>{ownerLabel(browser.owner)}</Tag>
        </div>
        <span className="browser-control-window-url" title={browser.url}>
          {browser.url || 'about:blank'}
        </span>
        {browser.title ? <span className="browser-control-window-meta">{browser.title}</span> : null}
        <span className="browser-control-window-meta">{tabSummary(browser)}</span>
      </div>
      <div className="browser-control-window-actions">
        <Button
          icon={<ShowIcon size={15} />}
          title="显示窗口"
          disabled={disabled || browser.visible}
          loading={busy}
          onClick={onShow}
        />
        <Button
          icon={<HideIcon size={15} />}
          title="隐藏窗口"
          disabled={disabled || !browser.visible}
          onClick={onHide}
        />
        <Button
          variant="danger"
          icon={<CloseIcon size={15} />}
          title="关闭窗口"
          disabled={disabled}
          onClick={onClose}
        />
      </div>
    </div>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
