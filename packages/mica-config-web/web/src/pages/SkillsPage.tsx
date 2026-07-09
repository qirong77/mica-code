import { useEffect, useState } from 'react';
import { Alert, Button, DescriptionList, Empty } from '../components/Ui.js';
import { readSkillsDetails } from '../api.js';
import type { ConfigWebSkillsDetails } from '../../../src/shared/types.js';

export function SkillsPage() {
  const [details, setDetails] = useState<ConfigWebSkillsDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setDetails(await readSkillsDetails());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="detail-page">
      <header className="editor-header">
        <div>
          <h2>Skills</h2>
          <p className="path-text">{details?.root ?? ''}</p>
        </div>
        <Button icon="↻" title="重新加载" onClick={load} loading={loading} />
      </header>
      {error ? <Alert message={error} /> : null}
      <div className="detail-body">
        {!details || details.skills.length === 0 ? (
          <Empty description="暂无 Skills" />
        ) : (
          <div className="detail-list">
            {details.skills.map((skill) => (
              <section className="detail-card" key={skill.baseDir}>
                <div className="detail-card-title">
                  <h3>{skill.name}</h3>
                  <span className="muted-text">{skill.baseDir}</span>
                </div>
                <DescriptionList
                  items={[
                    { label: 'Description', value: skill.description },
                    { label: 'When To Use', value: skill.whenToUse },
                    { label: 'Argument Hint', value: skill.argumentHint },
                  ]}
                />
                {skill.contentPreview ? (
                  <pre className="skill-preview">{skill.contentPreview}</pre>
                ) : null}
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
