// 用真实插件的 view() 生成探针数据：面板长什么样由插件决定，探针只负责画。
// 用法：bun fixture.mjs（在仓库根跑不了 import 别名，直接在本目录跑）。
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createPanelHandler } from '../../../../plugins/ssh/Panel.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const dataDir = join(tmpdir(), 'mica-probe-plugin-panel', 'ssh');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const at = new Date('2026-11-20T00:23:09+08:00').toISOString();
writeFileSync(
  join(dataDir, 'data.json'),
  JSON.stringify(
    {
      version: 1,
      updatedAt: at,
      hostsSummary: '1 台（japan）',
      hosts: [
        {
          id: 'japan',
          host: '188.253.118.143',
          port: 22,
          user: 'root',
          auth: 'password',
          autoAdd: false,
          createdAt: at,
          updatedAt: at,
        },
      ],
    },
    null,
    2
  )
);
writeFileSync(
  join(dataDir, 'panel.json'),
  JSON.stringify({ tests: { japan: { at, ok: true, message: '连接成功 · 0.38s' } } }, null, 2)
);
// 会话范围：没改过（null）＝跟随「自动添加」，所以本次会话 0 台。
const scope = { explicit: () => [], set: () => {} };
const view = createPanelHandler({
  ctx: { dataDir },
  dataFile: join(dataDir, 'data.json'),
  scope,
  closeSession() {},
}).view();

writeFileSync(join(here, 'ssh-view.json'), `${JSON.stringify(view, null, 2)}\n`);
console.log('wrote ssh-view.json');
