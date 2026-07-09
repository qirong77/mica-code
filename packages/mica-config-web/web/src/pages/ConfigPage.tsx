import { useEffect, useState } from 'react';
import { MonacoJsonEditor } from '../components/MonacoJsonEditor.js';
import { Alert, Button } from '../components/Ui.js';
import { readConfigDescriptions, readSection, writeSection } from '../api.js';
import type { ConfigFieldDescription } from '../../../src/shared/types.js';

export function ConfigPage() {
  const [content, setContent] = useState('');
  const [path, setPath] = useState('');
  const [fields, setFields] = useState<ConfigFieldDescription[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

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
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1600);
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
      <header className="editor-header">
        <div>
          <h2>Config</h2>
          <p className="path-text">{path}</p>
        </div>
        <div className="toolbar">
          {saved ? <span className="save-status">已保存</span> : null}
          <Button icon="↻" title="重新加载" onClick={load} loading={loading} />
          <Button variant="primary" icon="✓" onClick={save} loading={saving}>
            保存
          </Button>
        </div>
      </header>
      {error ? <Alert message={error} /> : null}
      <div className="config-body">
        <aside className="field-help">
          <h3>字段说明</h3>
          <div className="field-help-list">
            {fields.map((field) => (
              <section className="field-help-item" key={field.key}>
                <strong>{field.title}</strong>
                <p>{field.description}</p>
                {field.example ? <code>{field.example}</code> : null}
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
