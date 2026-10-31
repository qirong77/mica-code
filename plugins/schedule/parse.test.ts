import { describe, expect, it } from 'vitest';
import { buildAgenda, daysBetween, parseSchedule, type ScheduleStage } from './parse.js';

/** 公告原文摘自 2026-10 的真实群公告（保留排期附近的行，链接与 case 计划照旧）。 */
const ANNOUNCEMENTS = {
  weizhang: `PRD：https://cooper.didichuxing.com/knowledge/2199671876754/2209561013393

排期：
10.15～10.21开发，10.22～10.26联调，10.27showcase，测试：10.28-10.30，走查+上线：11.02

文件名称：外呼确认信息模版-违章处置线上化
链接：https://cooper.didichuxing.com/docs2/document/2210116262827
密码：212909`,
  changzu: `排期：开发：10.27-11.02，联调：11.03-11.09，showcase：11.10，测试：11.10~11.13，走查上线：11.16

-------------以下为已上线报名部分-------------
B端-望岳：https://ddp.intra.xiaojukeji.com/requirement/story/R-ARPAL-749208?backUrl=/workbench/requirement
B端接口文档（详细）：https://cooper.didichuxing.com/knowledge/2201166492387/2209867474255`,
  dingSun: `B前端：林棋榕
技术方案：https://cooper.didichuxing.com/knowledge/2201166492387/2210141315424

开发：10-26-10-27，联调：10.28，showcase：10.29上午，测试：10.29下午-11.2，走查：11.3，上线：11.4`,
  wanfa: `后端技术文档：
https://cooper.didichuxing.com/knowledge/2201166492387/2210164555382
排期：开发：10.30、11.2，联调&提测：11.3，测试：11.4～11.5，上线：11.6（周五）
PRD
https://cooper.didichuxing.com/didocs/2209804287870`,
  env: `B 前端：108
后端环境：osim149`,
};

const REFERENCE = '2026-10-29';

function keys(stages: ScheduleStage[]): string[] {
  return stages.map((stage) => `${stage.key}:${stage.start}~${stage.end}`);
}

describe('parseSchedule', () => {
  it('不把不存在的月日换算成其它日期，闰年日期正常保留', () => {
    expect(parseSchedule('测试：2.30，上线：4.31', { reference: '2026-02-01' })).toEqual([]);
    expect(parseSchedule('测试：2.30-3.02', { reference: '2026-02-01' })).toEqual([]);
    expect(parseSchedule('测试：2.29', { reference: '2026-02-01' })).toEqual([]);
    expect(parseSchedule('测试：2.29', { reference: '2028-02-01' })[0]?.start).toBe('2028-02-29');
  });
  it('读「日期在前、阶段词在后」的写法', () => {
    const stages = parseSchedule(ANNOUNCEMENTS.weizhang, { reference: REFERENCE });
    expect(keys(stages)).toEqual([
      'dev:2026-10-15~2026-10-21',
      'integration:2026-10-22~2026-10-26',
      'showcase:2026-10-27~2026-10-27',
      'testing:2026-10-28~2026-10-30',
      'walkthrough:2026-11-02~2026-11-02',
      'release:2026-11-02~2026-11-02',
    ]);
  });

  it('读「阶段词在前、日期在后」的写法，并忽略链接与历史小节', () => {
    const stages = parseSchedule(ANNOUNCEMENTS.changzu, { reference: REFERENCE });
    expect(keys(stages)).toEqual([
      'dev:2026-10-27~2026-11-02',
      'integration:2026-11-03~2026-11-09',
      'showcase:2026-11-10~2026-11-10',
      'testing:2026-11-10~2026-11-13',
      'walkthrough:2026-11-16~2026-11-16',
      'release:2026-11-16~2026-11-16',
    ]);
  });

  it('连写日期、带半天说明与「小时段」的写法都能读', () => {
    const stages = parseSchedule(ANNOUNCEMENTS.dingSun, { reference: REFERENCE });
    expect(keys(stages)).toEqual([
      'dev:2026-10-26~2026-10-27',
      'integration:2026-10-28~2026-10-28',
      'showcase:2026-10-29~2026-10-29',
      'testing:2026-10-29~2026-11-02',
      'walkthrough:2026-11-03~2026-11-03',
      'release:2026-11-04~2026-11-04',
    ]);
  });

  it('不连续的日子保留全部日期，区间取首尾', () => {
    const stages = parseSchedule(ANNOUNCEMENTS.wanfa, { reference: REFERENCE });
    const dev = stages.find((stage) => stage.key === 'dev');
    expect(dev).toMatchObject({
      start: '2026-10-30',
      end: '2026-11-02',
      days: ['2026-10-30', '2026-11-02'],
    });
    expect(keys(stages.filter((stage) => stage.key.startsWith('integration')))).toEqual([
      'integration:2026-11-03~2026-11-03',
    ]);
    expect(stages.some((stage) => stage.key === 'submit')).toBe(true);
    expect(stages.find((stage) => stage.key === 'release')?.start).toBe('2026-11-06');
  });

  it('没有阶段词的公告返回空数组，不当成错误', () => {
    expect(parseSchedule(ANNOUNCEMENTS.env, { reference: REFERENCE })).toEqual([]);
    expect(parseSchedule('', { reference: REFERENCE })).toEqual([]);
    expect(
      parseSchedule('知识库空间：https://cooper.didichuxing.com/knowledge/share/book/Ty6KDC', { reference: REFERENCE }),
    ).toEqual([]);
  });

  it('跨年排期顺延到明年，旧日期不跟着顺延', () => {
    const nextYear = parseSchedule('排期：开发：12.20-12.28，上线：1.5', { reference: '2026-12-01' });
    expect(nextYear.find((stage) => stage.key === 'release')?.start).toBe('2027-01-05');
    const stale = parseSchedule('开发：8.15~8.20', { reference: '2026-10-29' });
    expect(stale[0]?.start).toBe('2026-08-15');
  });

  it('长阶段词吃掉被它包住的短词，同一个阶段不重复出行', () => {
    const stages = parseSchedule('case评审:10.26，测试:10.27~10.28', { reference: REFERENCE });
    expect(keys(stages)).toEqual(['case-review:2026-10-26~2026-10-26', 'testing:2026-10-27~2026-10-28']);
  });
});

describe('buildAgenda', () => {
  const groups = [
    {
      id: '4112539791899498752',
      name: '违章处置线上化',
      stages: parseSchedule(ANNOUNCEMENTS.weizhang, { reference: REFERENCE }),
    },
    {
      id: '4072298054100760832',
      name: '长租',
      stages: parseSchedule(ANNOUNCEMENTS.changzu, { reference: REFERENCE }),
    },
  ];

  it('今天的阶段按结束日排，并标出跑到第几天', () => {
    const { active, upcoming } = buildAgenda(groups, { today: '2026-10-29' });
    expect(active.map((item) => `${item.groupName}/${item.key}`)).toEqual(['违章处置线上化/testing', '长租/dev']);
    expect(active[0]).toMatchObject({ dayIndex: 2, span: 3, endIn: 1 });
    // 上线日还没到，落在「接下来」里；同一天的走查排在它后面
    expect(upcoming.map((item) => `${item.groupName}/${item.key}`)).toEqual([
      '违章处置线上化/release',
      '违章处置线上化/walkthrough',
      '长租/integration',
      '长租/testing',
      '长租/showcase',
    ]);
    expect(daysBetween('2026-10-29', '2026-11-02')).toBe(4);
  });

  it('结束的阶段不再出现，超出窗口的也不出现', () => {
    const { active, upcoming } = buildAgenda(groups, { today: '2026-11-05' });
    expect(active.map((item) => `${item.groupName}/${item.key}`)).toEqual(['长租/integration']);
    expect(active[0]).toMatchObject({ dayIndex: 3, span: 7 });
    expect(upcoming.map((item) => item.start).every((start) => start >= '2026-11-05')).toBe(true);
    expect(upcoming.every((item) => item.startIn <= 14)).toBe(true);
    const far = buildAgenda(groups, { today: '2026-10-29', horizonDays: 3 });
    expect(far.upcoming.every((item) => item.startIn <= 3)).toBe(true);
    // 11-16 的上线离 10-29 有 18 天，默认窗口（14 天）外
    expect(far.upcoming.some((item) => item.key === 'release' && item.start === '2026-11-16')).toBe(false);
  });
});
