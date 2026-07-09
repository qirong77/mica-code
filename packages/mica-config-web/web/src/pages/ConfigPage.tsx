import { useEffect, useState } from 'react';
import { MonacoJsonEditor } from '../components/MonacoJsonEditor.js';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button } from '../components/Ui.js';
import { readSection, writeSection } from '../api.js';
import { appIcons } from '../icons.js';

export function ConfigPage() {
  const [content, setContent] = useState('');
  const [path, setPath] = useState('');
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
      const payload = await readSection('config');
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
      title="Config"
      path={path}
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
      <div className="editor-only">
        <div className="editor-pane-header">
          <h3>settings.json</h3>
        </div>
        <div className="editor-host editor-host-large">
          <MonacoJsonEditor value={content} language="json" onChange={setContent} />
        </div>
      </div>
    </PageFrame>
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
