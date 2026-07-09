import { useEffect, useState } from 'react';
import { MonacoJsonEditor } from '../components/MonacoJsonEditor.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button } from '../components/Ui.js';
import { sectionDescriptions, sectionEyebrows } from '../dashboardData.js';
import { readConfigDescriptions, readSection, writeSection } from '../api.js';
import type { ConfigFieldDescription } from '../../../src/shared/types.js';
import { appIcons } from '../icons.js';

export function ConfigPage() {
  const [content, setContent] = useState('');
  const [path, setPath] = useState('');
  const [fields, setFields] = useState<ConfigFieldDescription[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const RefreshIcon = appIcons.refresh;
  const SaveIcon = appIcons.save;

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
    <PageFrame
      eyebrow={sectionEyebrows.config}
      title="Config"
      description={sectionDescriptions.config}
      path={path}
      meta={saved ? 'Saved' : loading ? 'Loading' : 'Editable'}
      stats={[
        { label: 'Fields', value: String(fields.length), meta: '字段说明' },
        { label: 'Updated', value: formatUpdatedState(saved, saving, loading), meta: '状态反馈' },
        { label: 'Mode', value: 'JSON', meta: 'Monaco editor' },
      ]}
      actions={
        <div className="toolbar">
          {saved ? <span className="save-status">已保存</span> : null}
          <Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={load} loading={loading} />
          <Button variant="primary" icon={<SaveIcon size={15} />} onClick={save} loading={saving}>
            保存
          </Button>
        </div>
      }
    >
      {error ? <Alert message={error} /> : null}
      <div className="config-body">
        <aside className="field-help">
          <div className="field-help-header">
            <div>
              <span className="panel-kicker">Field Guide</span>
              <h3>字段说明</h3>
            </div>
            <span className="panel-count">{fields.length}</span>
          </div>
          <div className="field-help-list">
            {fields.map((field) => (
              <section className="field-help-item" key={field.key}>
                <div className="field-help-item-head">
                  <strong>{field.title}</strong>
                  <span className="field-help-key">{field.key}</span>
                </div>
                <p>{field.description}</p>
                {field.example ? <code>{field.example}</code> : null}
              </section>
            ))}
          </div>
        </aside>
        <div className="editor-pane">
          <div className="editor-pane-header">
            <div>
              <span className="panel-kicker">Source</span>
              <h3>settings.json</h3>
            </div>
            <span className="editor-pane-meta">Monaco / Local file</span>
          </div>
          <div className="editor-host">
            <MonacoJsonEditor value={content} language="json" onChange={setContent} />
          </div>
        </div>
      </div>
    </PageFrame>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatUpdatedState(saved: boolean, saving: boolean, loading: boolean): string {
  if (saving) return 'Saving';
  if (loading) return 'Loading';
  if (saved) return 'Saved';
  return 'Ready';
}
