import { useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Empty, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
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
          <Typography.Title level={4}>Skills</Typography.Title>
          <Typography.Text type="secondary">{details?.root ?? ''}</Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading} />
      </header>
      {error ? <Alert className="editor-alert" type="error" message={error} showIcon /> : null}
      <div className="detail-body">
        {!details || details.skills.length === 0 ? (
          <Empty description="暂无 Skills" />
        ) : (
          <div className="detail-list">
            {details.skills.map((skill) => (
              <section className="detail-card" key={skill.baseDir}>
                <div className="detail-card-title">
                  <Typography.Title level={5}>{skill.name}</Typography.Title>
                  <Typography.Text type="secondary">{skill.baseDir}</Typography.Text>
                </div>
                <Descriptions size="small" column={1} bordered>
                  <Descriptions.Item label="Description">{skill.description}</Descriptions.Item>
                  {skill.whenToUse ? <Descriptions.Item label="When To Use">{skill.whenToUse}</Descriptions.Item> : null}
                  {skill.argumentHint ? <Descriptions.Item label="Argument Hint">{skill.argumentHint}</Descriptions.Item> : null}
                </Descriptions>
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
