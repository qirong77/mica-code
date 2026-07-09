import { Empty } from 'antd';

export function EmptyState() {
  return (
    <div className="empty-page">
      <Empty description="Plugins 暂不支持配置" />
    </div>
  );
}
