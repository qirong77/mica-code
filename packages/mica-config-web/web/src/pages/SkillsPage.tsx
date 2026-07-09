import { useEffect, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, DescriptionList, Empty } from '../components/Ui.js';
import { sectionDescriptions, sectionEyebrows } from '../dashboardData.js';
import { readSkillsDetails } from '../api.js';
import type { ConfigWebSkillsDetails } from '../../../src/shared/types.js';
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
      eyebrow={sectionEyebrows.skills}
      title="Skills"
      description={sectionDescriptions.skills}
      path={details?.root}
      meta={loading ? 'Refreshing' : 'Indexed'}
      stats={[
        { label: 'Skills', value: String(details?.skills.length ?? 0), meta: '当前加载' },
        { label: 'Preview', value: '800', meta: '字符截断上限' },
        { label: 'Intent', value: 'Docs', meta: '用于核对说明与提示' },
      ]}
      actions={<Button icon={<RefreshIcon size={15} />} title="重新加载" onClick={load} loading={loading} />}
    >
      {error ? <Alert message={error} /> : null}
      <div className="detail-body">
        {!details || details.skills.length === 0 ? (
          <Empty description="暂无 Skills" />
        ) : (
          <div className="detail-list">
            {details.skills.map((skill) => (
              <section className="detail-card" key={skill.baseDir}>
                <div className="detail-card-title">
                  <div className="title-stack">
                    <h3>{skill.name}</h3>
                    <p className="detail-card-subtitle">{skill.baseDir}</p>
                  </div>
                  <span className="metric-chip">Skill</span>
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
    </PageFrame>
  );
}
