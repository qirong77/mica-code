import { useEffect, useMemo, useState } from 'react';
import { PageFrame } from '../components/PageFrame.js';
import { Alert, Button, DataTable, Empty, SegmentTabs } from '../components/Ui.js';
import { sectionDescriptions, sectionEyebrows } from '../dashboardData.js';
import { readSkillsDetails } from '../api.js';
import type { ConfigWebSkillsDetails } from '../../../src/shared/types.js';
import { appIcons } from '../icons.js';

type SkillView = 'catalog' | 'preview';

export function SkillsPage() {
  const [details, setDetails] = useState<ConfigWebSkillsDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<SkillView>('catalog');
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const RefreshIcon = appIcons.refresh;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const next = await readSkillsDetails();
      setDetails(next);
      setSelectedSkill((current) => current ?? next.skills[0]?.baseDir ?? null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const selected = useMemo(() => details?.skills.find((skill) => skill.baseDir === selectedSkill) ?? details?.skills[0] ?? null, [details, selectedSkill]);

  const rows = (details?.skills ?? []).map((skill) => [
    <button key={skill.baseDir} className={`table-link ${selected?.baseDir === skill.baseDir ? 'table-link-active' : ''}`} type="button" onClick={() => setSelectedSkill(skill.baseDir)}>
      <strong>{skill.name}</strong>
      <span>{skill.baseDir}</span>
    </button>,
    <span className="table-wrap-text" key={`${skill.baseDir}-desc`}>{skill.description}</span>,
    <span className="table-wrap-text" key={`${skill.baseDir}-when`}>{skill.whenToUse || '-'}</span>,
    <span className="table-wrap-text" key={`${skill.baseDir}-arg`}>{skill.argumentHint || '-'}</span>,
  ]);

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
      <div className="detail-body detail-body-stacked">
        <div className="section-toolbar">
          <SegmentTabs
            items={[
              { key: 'catalog', label: 'Catalog', count: details?.skills.length ?? 0 },
              { key: 'preview', label: 'Preview', count: selected ? 1 : 0 },
            ]}
            value={view}
            onChange={(next) => setView(next as SkillView)}
          />
        </div>

        {!details || details.skills.length === 0 ? (
          <Empty description="暂无 Skills" />
        ) : view === 'catalog' ? (
          <DataTable columns={['Skill', 'Description', 'When To Use', 'Argument Hint']} rows={rows} emptyMessage="暂无 Skills" />
        ) : selected ? (
          <section className="table-panel skill-preview-panel">
            <header className="table-panel-header">
              <div className="table-panel-title">
                <strong>{selected.name}</strong>
                <span>{selected.baseDir}</span>
              </div>
            </header>
            <div className="skill-meta-grid">
              <div className="skill-meta-item">
                <span>Description</span>
                <strong>{selected.description}</strong>
              </div>
              <div className="skill-meta-item">
                <span>When To Use</span>
                <strong>{selected.whenToUse || '-'}</strong>
              </div>
              <div className="skill-meta-item">
                <span>Argument Hint</span>
                <strong>{selected.argumentHint || '-'}</strong>
              </div>
            </div>
            {selected.contentPreview ? <pre className="skill-preview">{selected.contentPreview}</pre> : null}
          </section>
        ) : (
          <Empty description="请选择一个 Skill 查看预览" />
        )}
      </div>
    </PageFrame>
  );
}

