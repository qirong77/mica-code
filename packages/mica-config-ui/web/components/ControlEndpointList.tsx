import { useMemo } from 'react';
import { appIcons } from '../icons.js';
import { groupEndpoints } from '../controlEndpoints.js';
import { Button, Empty } from './Ui.js';
import type { ConfigWebBrowserControlEndpoint } from '../../src/shared/types.js';

/**
 * 受控浏览器与终端控制共用的接口文档列表。
 *
 * 两个页面的端点目录形状相同（见 `controlEndpoints.ts`），排版必须一致，否则「改了一边忘了
 * 另一边」的漂移会立刻变成两种观感。一行一个端点：路径在前、说明跟在后面，展开才显示参数与
 * curl 示例 —— 12～27 个端点铺成卡片会把整页撑成一屏清单。
 */
export function ControlEndpointList({
  endpoints,
  exampleFor,
  emptyDescription,
  onCopy,
}: {
  endpoints: ConfigWebBrowserControlEndpoint[] | null | undefined;
  /** 拼 curl 示例：两个服务用的地址与环境变量不同，由页面注入。 */
  exampleFor(endpoint: ConfigWebBrowserControlEndpoint): string;
  emptyDescription: string;
  onCopy(text: string): void;
}) {
  const groups = useMemo(() => groupEndpoints(endpoints), [endpoints]);
  const ChevronIcon = appIcons.chevronRight;

  if (groups.length === 0) return <Empty description={emptyDescription} />;

  return (
    <div className="control-groups">
      {groups.map((group) => (
        <section className="control-group" key={group.method}>
          <header className="control-group-head">
            <span className={`control-method control-method-${group.method.toLowerCase()}`}>{group.label}</span>
            <span className="control-group-count">{group.endpoints.length} 个接口</span>
          </header>
          <div className="control-endpoints">
            {group.endpoints.map((endpoint) => {
              const example = endpoint.example || exampleFor(endpoint);
              return (
                <details className="control-endpoint" key={endpoint.id}>
                  <summary className="control-endpoint-summary">
                    <code className="control-endpoint-path">{endpoint.path}</code>
                    <span className="control-endpoint-desc">{endpoint.summary}</span>
                    <ChevronIcon className="control-endpoint-chevron" size={14} aria-hidden="true" />
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
                        <Button onClick={() => onCopy(example)}>复制</Button>
                      </div>
                      <pre className="code-preview">{example}</pre>
                    </div>
                  </div>
                </details>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
