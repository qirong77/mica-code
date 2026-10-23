// 从公开的汇总数据生成 README / 官网评测图。
// 数据口径与限制见 apps/website/public/benchmark-data.json。
// bun scripts/generate-eval-chart.mjs

import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const data = JSON.parse(readFileSync(join(root, 'apps/website/public/benchmark-data.json'), 'utf8'));
const TOTAL = data.tasks.reduce((sum, task) => sum + task.checks, 0);
const rows = data.results.map((row) => ({
  ...row,
  cache: `${row.cachePercent.toFixed(1)}%`,
  minutes: `${row.minutes.toFixed(1)} 分钟`,
  turns: row.requests,
  highlight: row.name === 'Mica Code',
}));

const WIDTH = 1180;
const HEIGHT = 276;
const ROW_TOP = 58;
const ROW_GAP = 38;
const BAR_X = 220;
const BAR_W = 300;
const BAR_H = 18;
const AXIS_MIN = 95;
const AXIS_MAX = 100;

const MUTED = '#6b7280';
const FAINT = '#9ca3af';
const STRONG = '#111827';
const TRACK = 'rgba(148,163,184,0.16)';

const fmt = (value) => String(Number(value.toFixed(1)));
const pct = (passed) => (passed / TOTAL) * 100;
const pctText = (passed) => pct(passed).toFixed(1);
const barWidth = (passed) =>
  Math.max(6, Number((((pct(passed) - AXIS_MIN) / (AXIS_MAX - AXIS_MIN)) * BAR_W).toFixed(1)));

const parts = [];
parts.push(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="DeepSWE 任务自主评测：五款 agent 在 9 项任务、${TOTAL} 个自定义检查项上的得分、缓存命中率、耗时与模型请求数对比">`,
);
parts.push(`<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" rx="14" fill="#fdfdfd"/>`);
parts.push(
  `<g font-family="-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Helvetica Neue',Arial,sans-serif">`,
);
parts.push(`<text x="40" y="40" font-size="11.5" fill="${MUTED}" letter-spacing="0.06em">检查项得分</text>`);
parts.push(`<text x="130" y="40" font-size="10.5" fill="${FAINT}">坐标 ${AXIS_MIN}%–${AXIS_MAX}%</text>`);
parts.push(`<text x="760" y="40" font-size="11.5" fill="${MUTED}" text-anchor="end">缓存命中率</text>`);
parts.push(`<text x="930" y="40" font-size="11.5" fill="${MUTED}" text-anchor="end">耗时汇总</text>`);
parts.push(`<text x="1060" y="40" font-size="11.5" fill="${MUTED}" text-anchor="end">模型请求数</text>`);

rows.forEach((row, index) => {
  const y = ROW_TOP + index * ROW_GAP;
  const color = row.highlight ? STRONG : MUTED;
  const weight = row.highlight ? '700' : '400';
  parts.push(`<text x="40" y="${y + 14}" font-size="13" font-weight="${weight}" fill="${color}">${row.name}</text>`);
  parts.push(`<rect x="${BAR_X}" y="${y}" width="${BAR_W}" height="${BAR_H}" rx="4" fill="${TRACK}"/>`);
  parts.push(
    `<rect x="${BAR_X}" y="${y}" width="${barWidth(row.passed)}" height="${BAR_H}" rx="4" fill="${
      row.highlight ? '#1287a1' : '#a4b8c2'
    }"/>`,
  );
  parts.push(
    `<text x="532" y="${y + 13}" font-size="12" font-weight="${weight}" fill="${color}">${fmt(
      row.passed,
    )}/${TOTAL} · ${pctText(row.passed)}%</text>`,
  );
  parts.push(
    `<text x="760" y="${y + 13}" font-size="12.5" font-weight="${weight}" fill="${color}" text-anchor="end">${row.cache}</text>`,
  );
  parts.push(
    `<text x="930" y="${y + 13}" font-size="12.5" font-weight="${weight}" fill="${color}" text-anchor="end">${row.minutes}</text>`,
  );
  parts.push(
    `<text x="1060" y="${y + 13}" font-size="12.5" font-weight="${weight}" fill="${color}" text-anchor="end">${row.turns}</text>`,
  );
});

// 放大坐标的刻度
const axisY = ROW_TOP + rows.length * ROW_GAP - 8;
parts.push(
  `<line x1="${BAR_X}" y1="${axisY}" x2="${BAR_X + BAR_W}" y2="${axisY}" stroke="rgba(148,163,184,0.45)" stroke-width="1"/>`,
);
[95, 96, 97, 98, 99, 100].forEach((tick) => {
  const x = BAR_X + ((tick - AXIS_MIN) / (AXIS_MAX - AXIS_MIN)) * BAR_W;
  const last = tick === AXIS_MAX || tick === AXIS_MIN;
  parts.push(
    `<line x1="${x}" y1="${axisY}" x2="${x}" y2="${axisY + (last ? 6 : 4)}" stroke="rgba(148,163,184,${
      last ? 0.75 : 0.45
    })" stroke-width="1"/>`,
  );
  parts.push(
    `<text x="${x}" y="${axisY + 19}" font-size="10.5" fill="${FAINT}" text-anchor="${tick === AXIS_MIN ? 'start' : tick === AXIS_MAX ? 'end' : 'middle'}">${tick}%</text>`,
  );
});

parts.push(
  `<text x="532" y="${axisY + 19}" font-size="10.5" fill="${FAINT}">未通过的检查项：Codex 2 · Mica 4.5 · MiniMax 4.5 · DSH 6 · Claude 7</text>`,
);
parts.push('</g></svg>');

const svg = `${parts.join('\n')}\n`;
const out = join(root, 'images', 'eval-benchmark.svg');
writeFileSync(out, svg);

const siteDir = join(root, 'apps', 'website', 'public', 'screenshots');
mkdirSync(siteDir, { recursive: true });
copyFileSync(out, join(siteDir, 'eval-benchmark.svg'));

console.log(`wrote ${out}`);
