import { useEffect, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, CollapsiblePanel, Empty } from '../components/Ui.js';
import { readSkillsDetails } from '../api.js';
import type { ConfigWebSkill, ConfigWebSkillsDetails } from '../../../src/shared/types.js';
import { appIcons } from '../icons.js';

export function SkillsPage() {
  const [details, setDetails] = useState<ConfigWebSkillsDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const RefreshIcon = appIcons.refresh;

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
    <PageFrame
      title="Skills"
      path={details?.root}
      actions={<Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={load} loading={loading} />}
    >
      {error ? <Alert message={error} /> : null}
      <div className="detail-body detail-body-stacked">
        {!details || details.skills.length === 0 ? (
          <Empty description="暂无 Skills" />
        ) : (
          <div className="stacked-panels">
            {details.skills.map((skill) => (
              <SkillCard key={skill.baseDir} skill={skill} />
            ))}
          </div>
        )}
      </div>
    </PageFrame>
  );
}

function SkillCard({ skill }: { skill: ConfigWebSkill }) {
  return (
    <CollapsiblePanel title={skill.name} subtitle={skill.baseDir}>
      <div className="simple-list">
        <div className="simple-row">
          <span>Description</span>
          <strong>{skill.description}</strong>
        </div>
        <div className="simple-row">
          <span>When To Use</span>
          <strong>{skill.whenToUse || '-'}</strong>
        </div>
        <div className="simple-row">
          <span>Argument Hint</span>
          <strong>{skill.argumentHint || '-'}</strong>
        </div>
      </div>
      <div style={{ marginTop: '4px' }}></div>
      {skill.contentPreview ? <pre className="skill-preview">{skill.contentPreview}</pre> : null}
    </CollapsiblePanel>
  );
}
