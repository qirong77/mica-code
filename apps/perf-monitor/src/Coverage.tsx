import { Alert, Empty, Tag } from 'antd';
import type { CollectorStatus, Overview } from '../shared/types';
import { dateTime, duration, number } from './format';
import { HealthBadge, Icon, Panel } from './UI';

const statusLabels: Record<CollectorStatus['state'], string> = {
  running: '已采集',
  stale: '数据过期',
  unavailable: '不可用',
  'not-installed': '尚未安装',
};
const statusHealth = { running: 'ok', stale: 'warning', unavailable: 'unknown', 'not-installed': 'unknown' } as const;

export function Coverage({ overview }: { overview: Overview }) {
  const { coverage, collectors } = overview;
  return (
    <div className="coverage-page">
      <div className="coverage-stat-grid">
        <div>
          <span className="eyebrow">SAMPLES</span>
          <strong>{number(coverage.sampleCount, 0)}</strong>
          <span>当前窗口有效样本</span>
        </div>
        <div>
          <span className="eyebrow">PROCESS RECORDS</span>
          <strong>{number(coverage.recordedCount, 0)}</strong>
          <span>已记录进程条目</span>
        </div>
        <div>
          <span className="eyebrow">PROCESSES</span>
          <strong>{number(coverage.processCount, 0)}</strong>
          <span>成功读取的进程数</span>
        </div>
        <div>
          <span className="eyebrow">PARSE ERRORS</span>
          <strong className={coverage.parseErrors ? 'text-amber' : ''}>{number(coverage.parseErrors, 0)}</strong>
          <span>解析异常</span>
        </div>
      </div>
      <Panel title="采集器状态" eyebrow="COLLECTION COVERAGE" extra={<span className="caption">依据实际采集结果</span>}>
        <div className="collector-grid">
          {collectors.map((collector) => (
            <article className="collector-card" key={collector.id}>
              <div className="collector-card-top">
                <span className={`collector-icon collector-${collector.state}`}>
                  <Icon name="coverage" size={20} />
                </span>
                <HealthBadge health={statusHealth[collector.state]} label={statusLabels[collector.state]} />
              </div>
              <h3>{collector.name}</h3>
              <p>{collector.detail}</p>
              <div className="collector-last">
                最近记录 <span>{dateTime(collector.lastSeen)}</span>
              </div>
            </article>
          ))}
          {!collectors.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="接口尚未返回采集器状态" />}
        </div>
      </Panel>
      <div className="coverage-bottom-grid">
        <Panel title="数据窗口" eyebrow="DATA PROVENANCE">
          <dl className="coverage-definition">
            <div>
              <dt>选择日期</dt>
              <dd>{overview.day}</dd>
            </div>
            <div>
              <dt>首个样本</dt>
              <dd>{dateTime(coverage.from)}</dd>
            </div>
            <div>
              <dt>最后样本</dt>
              <dd>{dateTime(coverage.to)}</dd>
            </div>
            <div>
              <dt>最新全局记录</dt>
              <dd>{dateTime(overview.latestOverallAt)}</dd>
            </div>
            <div>
              <dt>所选样本距今</dt>
              <dd>{duration(overview.ageSeconds)}</dd>
            </div>
            <div>
              <dt>接口生成时间</dt>
              <dd>{dateTime(overview.generatedAt)}</dd>
            </div>
          </dl>
        </Panel>
        <Panel title="指标的边界" eyebrow="READ THE SIGNAL">
          <div className="coverage-explanations">
            <div>
              <Tag color="cyan">CPU</Tag>
              <p>
                主机 CPU 是当前运行主机的计数器差值，不是所选历史时段的 CPU。进程 CPU 按单逻辑核计，100% 约等于一个核。
              </p>
            </div>
            <div>
              <Tag color="purple">内存</Tag>
              <p>
                Footprint 用于比较进程的内存归属；各进程相加不代表物理内存占用。Swap
                总量较高本身不代表系统卡死，应结合换入换出和内存压力。
              </p>
            </div>
            <div>
              <Tag>进程 I/O</Tag>
              <p>
                V2
                采集器提供可读取进程的磁盘字节增量；旧采样和受保护进程保留缺口。具体文件路径需要异常追踪，系统吞吐不能直接归属到某个进程。
              </p>
            </div>
            <div>
              <Tag>root 写盘</Tag>
              <p>
                只有实际存在文件追踪附件时才显示“已采集”。未安装 root
                抓取器时，不提供文件级写入归因；观察到写入也不能单独判定根因。
              </p>
            </div>
          </div>
        </Panel>
      </div>
      {coverage.warnings.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="采集提示"
          description={
            <ul className="warning-list">
              {coverage.warnings.map((warning, index) => (
                <li key={`${index}:${warning}`}>{warning}</li>
              ))}
            </ul>
          }
        />
      )}
    </div>
  );
}
