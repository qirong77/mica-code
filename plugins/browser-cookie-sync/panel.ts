import type {
  PluginPanelActionResult,
  PluginPanelHandler,
  PluginPanelSection,
  PluginPanelTable,
  PluginPanelView
} from '@packages/mica-plugin/index.js';
import { CHROMIUM_BROWSERS, DEFAULT_BROWSER_ID } from './chrome/profiles.js';
import { readPluginData, type PluginData } from './status.js';
import { readState, stateFilePath } from './state.js';

/**
 * 面板：状态 → 方向开关 → 冲突。
 *
 * 这里**只读本地文件**（设置、`data.json`、基线），不探测 Chrome、不问钥匙串：面板每打开
 * 一次、每切一次分区都会重新取视图，把探测放在这里会让「看一眼」变成一次系统调用。
 * 真正的探测只在同步那一下做，结果顺手缓存进 `data.json`（配置文件清单就是缓存的那份）。
 */

export type PanelDeps = {
  dataDir: string;
  settings(): Record<string, string>;
  saveSettings(values: Record<string, string>): void;
  sync(input: { dryRun: boolean; resolve?: { key: string; side: 'chrome' | 'mica' } }): Promise<{ message: string }>;
};

const SAVE_ACTION = 'save';

function onOff(value: string | undefined, fallback: boolean): 'true' | 'false' {
  if (value === 'true' || value === 'false') return value;
  return fallback ? 'true' : 'false';
}

function browserOptions(): { value: string; label: string }[] {
  return CHROMIUM_BROWSERS.map((browser) => ({ value: browser.id, label: browser.label }));
}

function profileOptions(data: PluginData, current: string): { value: string; label: string }[] {
  const cached = Array.isArray(data.profiles) ? data.profiles : [];
  const options = [{ value: '', label: '上次用的那个' }].concat(
    cached.map((profile) => ({ value: profile.dir, label: profile.name || profile.dir }))
  );
  // 设置的还是上次探测之前选的那个、而缓存里已经没有它时，别让下拉框显示成空白
  if (current && !options.some((option) => option.value === current)) {
    options.push({ value: current, label: `${current}（已不在）` });
  }
  return options;
}

function conflictTable(data: PluginData): PluginPanelTable | null {
  const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
  if (conflicts.length === 0) return null;
  return {
    columns: [
      { key: 'cookie', label: 'Cookie', grow: true },
      { key: 'path', label: '路径' }
    ],
    rows: conflicts.slice(0, 50).map((conflict) => ({
      key: conflict.key,
      cells: {
        cookie: { text: conflict.name, sub: conflict.host },
        path: { text: conflict.path || '/', tone: 'muted' as const }
      },
      actions: [
        { id: 'use-chrome', label: '用 Chrome 的' },
        { id: 'use-mica', label: '用 Mica 的' }
      ]
    }))
  };
}

export function createPanelHandler(deps: PanelDeps): PluginPanelHandler {
  return {
    view(): PluginPanelView {
      const settings = deps.settings();
      const data = readPluginData(deps.dataDir);
      const state = readState(stateFilePath(deps.dataDir));
      const browserId = String(settings.browser || '').trim() || DEFAULT_BROWSER_ID;
      const currentProfile = String(settings.profile || '');
      const conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];
      const notes = Array.isArray(data.notes) ? data.notes : [];

      const statusSections: PluginPanelSection = {
        title: '状态',
        subtitle: data.target?.text || '还没同步过：先点「立即同步」试一次',
        rows: [
          ...(data.lastRun
            ? [{ label: '上次同步', value: data.lastRun.text, tone: data.lastRun.tone, wrap: true }]
            : []),
          ...(data.counts ? [{ label: '两边条数', value: data.counts.text, tone: data.counts.tone }] : []),
          ...(data.access ? [{ label: '权限', value: data.access.text, tone: data.access.tone, wrap: true }] : []),
          ...notes.map((note) => ({ label: '注意', value: note, wrap: true as const }))
        ]
      };

      const optionsSection: PluginPanelSection = {
        title: '同步',
        subtitle: '全量同步：不按域名筛，两边各自新增或被改动的都会写到对面',
        fields: [
          {
            key: 'browser',
            label: '浏览器',
            type: 'select',
            value: browserId,
            options: browserOptions()
          },
          {
            key: 'profile',
            label: '配置文件',
            type: 'select',
            value: currentProfile,
            options: profileOptions(data, currentProfile)
          },
          {
            key: 'toMica',
            label: 'Chrome → 受控浏览器',
            type: 'switch',
            value: onOff(settings.toMica, true),
            hint: '把 Chrome 的登录态搬进 Mica 的浏览器'
          },
          {
            key: 'toChrome',
            label: '受控浏览器 → Chrome',
            type: 'switch',
            value: onOff(settings.toChrome, true),
            hint: '反过来写回真实 Chrome；两边都变过的不会覆盖'
          },
          {
            key: 'writeWhileRunning',
            label: 'Chrome 开着也写',
            type: 'switch',
            value: onOff(settings.writeWhileRunning, false),
            hint: 'Chrome 把 cookie 常驻在内存里：写进去要重启它才生效'
          }
        ],
        commit: SAVE_ACTION,
        actions: [
          { id: 'preview', label: '试算', tone: 'ghost', hint: '只算差异，不写任何一侧' },
          { id: 'sync', label: '立即同步', tone: 'primary' }
        ]
      };

      const table = conflictTable(data);
      const conflictSection: PluginPanelSection = {
        title: '冲突',
        subtitle:
          conflicts.length > 0
            ? `${conflicts.length} 条两边都变过，谁都不动：选一边覆盖另一边`
            : '两边都改过的 cookie 会列在这里',
        ...(table ? { table } : {}),
        empty: '没有冲突'
      };

      return {
        title: 'Cookie 同步',
        subtitle: `${data.target?.text || 'Chrome ↔ 受控浏览器'}`,
        status: data.lastRun
          ? { label: data.lastRun.text.length > 28 ? '已同步' : data.lastRun.text, tone: data.lastRun.tone }
          : { label: '未同步', tone: 'muted' },
        statusBar: {
          label: 'Cookie 同步',
          tone: conflicts.length > 0 ? 'warn' : data.lastRun?.tone || 'muted',
          detail: conflicts.length > 0 ? `${conflicts.length} 条冲突` : state.lastRun ? '已同步' : '未同步',
          section: '同步'
        },
        sections: [statusSections, optionsSection, conflictSection]
      };
    },

    async action(input): Promise<PluginPanelActionResult> {
      const values = input.values ?? {};
      if (input.action === SAVE_ACTION) {
        try {
          deps.saveSettings(pickSettings(values));
          // 自动提交只是把草稿同步给插件：让宿主按新视图重置表单，会在用户还没选完的
          // 下拉框上闪一下。
          return { keepDrafts: true };
        } catch (error) {
          return { message: error instanceof Error ? error.message : String(error), keepDrafts: true };
        }
      }
      if (input.action === 'preview') {
        return { message: (await deps.sync({ dryRun: true })).message };
      }
      if (input.action === 'sync') {
        return { message: (await deps.sync({ dryRun: false })).message };
      }
      if (input.action === 'use-chrome' || input.action === 'use-mica') {
        const key = String(input.key || '');
        if (!key) return { message: '没有指明是哪一条 cookie' };
        return {
          message: (
            await deps.sync({
              dryRun: false,
              resolve: { key, side: input.action === 'use-chrome' ? 'chrome' : 'mica' }
            })
          ).message
        };
      }
      return { message: `不认识的动作：${input.action}` };
    }
  };
}

/** 只有声明过的键才写回设置：面板字段与 `plugin.json` 的 `settings` 是同几个名字。 */
function pickSettings(values: Record<string, string>): Record<string, string> {
  const allowed = ['browser', 'profile', 'toMica', 'toChrome', 'writeWhileRunning'];
  const out: Record<string, string> = {};
  for (const key of allowed) {
    if (values[key] !== undefined) out[key] = String(values[key]);
  }
  return out;
}
