import { Menu } from 'antd';
import { CodeOutlined, ControlOutlined, ProductOutlined, ToolOutlined } from '@ant-design/icons';
import type { ConfigWebSection } from '../../../src/shared/types.js';

const items = [
  { key: 'config', icon: <ControlOutlined />, label: 'Config' },
  { key: 'mcp', icon: <CodeOutlined />, label: 'MCP' },
  { key: 'skills', icon: <ToolOutlined />, label: 'Skills' },
  { key: 'plugins', icon: <ProductOutlined />, label: 'Plugins' },
];

type SidebarProps = {
  section: ConfigWebSection;
  onChange(section: ConfigWebSection): void;
};

export function Sidebar({ section, onChange }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="brand">Mica</div>
      <Menu
        mode="inline"
        selectedKeys={[section]}
        items={items}
        onClick={(event) => onChange(event.key as ConfigWebSection)}
      />
    </aside>
  );
}
