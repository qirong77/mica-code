import { useEffect, useState } from 'react';
import { Alert, Button, Space, Typography, message } from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { MonacoJsonEditor } from '../components/MonacoJsonEditor.js';
import { readConfigDescriptions, readSection, writeSection } from '../api.js';
import type { ConfigFieldDescription } from '../../../src/shared/types.js';

export function ConfigPage() {
  const [content, setContent] = useState('');
  const [path, setPath] = useState('');
  const [fields, setFields] = useState<ConfigFieldDescription[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [payload, descriptions] = await Promise.all([readSection('config'), readConfigDescriptions()]);
      setContent(payload.content);
      setPath(payload.path ?? '');
      setFields(descriptions);
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
      const payload = await writeSection('config', content);
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
  }, []);

  return (
    <section className="editor-page config-page">
      {contextHolder}
      <header className="editor-header">
        <div>
          <Typography.Title level={4}>Config</Typography.Title>
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
      <div className="config-body">
        <aside className="field-help">
          <Typography.Title level={5}>字段说明</Typography.Title>
          <div className="field-help-list">
            {fields.map((field) => (
              <section className="field-help-item" key={field.key}>
                <Typography.Text strong>{field.title}</Typography.Text>
                <Typography.Paragraph type="secondary">{field.description}</Typography.Paragraph>
                {field.example ? <Typography.Text type="secondary">{field.example}</Typography.Text> : null}
              </section>
            ))}
          </div>
        </aside>
        <div className="editor-host">
          <MonacoJsonEditor value={content} language="json" onChange={setContent} />
        </div>
      </div>
    </section>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
