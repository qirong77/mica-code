import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Space, Typography, message } from 'antd';
import { SaveOutlined, ReloadOutlined } from '@ant-design/icons';
import { MonacoJsonEditor } from '../components/MonacoJsonEditor.js';
import { readSection, writeSection } from '../api.js';
import type { ConfigWebSection } from '../../../src/shared/types.js';

type EditorPageProps = {
  section: Exclude<ConfigWebSection, 'plugins'>;
};

export function EditorPage({ section }: EditorPageProps) {
  const [content, setContent] = useState('');
  const [path, setPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const title = useMemo(() => sectionTitle(section), [section]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const payload = await readSection(section);
      setContent(payload.content);
      setPath(payload.path ?? '');
    } catch (loadError) {
      setError(formatError(loadError));
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload = await writeSection(section, content);
      setContent(payload.content);
      messageApi.success('已保存');
    } catch (saveError) {
      setError(formatError(saveError));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    void load();
  }, [section]);

  return (
    <section className="editor-page">
      {contextHolder}
      <header className="editor-header">
        <div>
          <Typography.Title level={4}>{title}</Typography.Title>
          <Typography.Text type="secondary">{path}</Typography.Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading} />
          <Button type="primary" icon={<SaveOutlined />} onClick={save} loading={saving}>
            保存
          </Button>
        </Space>
      </header>
      {error ? <Alert className="editor-alert" type="error" message={error} showIcon /> : null}
      <div className="editor-host">
        <MonacoJsonEditor value={content} language="json" onChange={setContent} />
      </div>
    </section>
  );
}

function sectionTitle(section: ConfigWebSection): string {
  if (section === 'config') return 'Config';
  if (section === 'mcp') return 'MCP';
  if (section === 'skills') return 'Skills';
  return 'Plugins';
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
