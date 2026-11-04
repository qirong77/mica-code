import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PluginPanelActionResult,
  PluginPanelHandler,
  PluginPanelSection,
  PluginPanelTable,
  PluginPanelTableCell,
  PluginPanelTableRow,
  PluginPanelView,
} from '@packages/mica-plugin/index.js';
import { mutateData, readData, upsertHost, type SshAuth, type SshHost } from './Hosts.js';
import { readHostFingerprint, testConnection, type RemoteContext } from './Remote.js';
import { scopedHosts, type SshScope } from './Scope.js';
import { deletePassword, hasStoredPassword, storePassword } from './Secrets.js';

/**
 * 配置面板：插件给数据、宿主画出来（`display: 'modal'`）。
 *
 * 两块：**服务器**（一张表：名称 / 地址 / 状态 / 操作 / 两列勾选）与**添加**（表单 + 一个
 * 「连接」按钮）。最近调用记录不在这里——那是 `audit.jsonl` 的事，面板上摊一份既占地方
 * 又没人会用它的逐行脚本。
 *
 * 「这台机器对模型可不可见」由表里的两列回答，没有另外的全局开关：
 * - 添加到会话：本次会话，存在会话快照（见 `Scope.ts`）；
 * - 自动添加到会话：以后的新会话默认带上它，存在主机清单里。
 *
 * 口令是这个面板独有的输入，也是唯一**不回填**的字段：`view()` 里它永远是空串（提示写
 * 「已保存」），动作提交后再写进 `Secrets.ts` 的 0600 文件。所以页面、截图、分享出去的
 * 界面里都不会出现口令，模型更是从头到尾只看到主机别名。
 *
 * 面板会被反复调用（每次动作后宿主重新取视图），所以 `view()` 只读文件、不跑外部命令；
 * 唯一会连服务器的是「连接」。
 */

export const PANEL_STATE_FILE = 'panel.json';

type HostTest = { at: string; ok: boolean; message: string; fingerprint?: string };

/** 正在填的那台机器：切认证方式、切页签都不该把已经敲进去的地址丢掉。 */
type Draft = {
  id: string;
  host: string;
  port: string;
  user: string;
  label: string;
  keyPath: string;
  auth: SshAuth;
};

type PanelState = {
  editingId?: string;
  draft?: Draft;
  pendingDelete?: string;
  /** 每台机器最近一次连接的结果：状态列就是它（按 hostId 记，删掉机器时一起清）。 */
  tests?: Record<string, HostTest>;
};

/** 新机器的默认用户名：绝大多数自建服务器就是 `root`，让人每次手敲一遍没有意义。 */
export const DEFAULT_SSH_USER = 'root';

function emptyDraft(): Draft {
  return { id: '', host: '', port: '22', user: DEFAULT_SSH_USER, label: '', keyPath: '', auth: 'password' };
}

function readState(dataDir: string): PanelState {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, PANEL_STATE_FILE), 'utf8')) as PanelState;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(dataDir: string, state: PanelState): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, PANEL_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    // 记住草稿状态失败不影响功能
  }
}

function field(values: Record<string, string> | undefined, key: string): string {
  return String(values?.[key] ?? '').trim();
}

function clockOf(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function draftOf(host: SshHost | null, current: PanelState): Draft {
  const draft = current.draft;
  // 老草稿里可能留着空用户名（默认值改成 root 之前存的），读回来时补上。
  if (draft && (!host || draft.id === host.id)) return { ...draft, user: draft.user || DEFAULT_SSH_USER };
  if (!host) return emptyDraft();
  return {
    id: host.id,
    host: host.host,
    port: String(host.port),
    user: host.user || DEFAULT_SSH_USER,
    label: host.label ?? '',
    keyPath: host.keyPath ?? '',
    auth: host.auth,
  };
}

/**
 * 状态列：这台机器上次连上了没有。
 *
 * 「连上了」只说明那次握手成功过——它不代表连接池里现在就有一条活着的连接（那由
 * `Remote.ts` 的 ControlMaster 管，面板读不到也不该去问）。所以文案写「上次连接」而不是
 * 「当前状态」，别让它看起来像一个实时指示灯。
 */
function statusCell(test: HostTest | undefined): PluginPanelTableCell {
  if (!test) return { text: '未测试', tone: 'muted' };
  return {
    text: test.ok ? '已连接' : '连不上',
    // 时间退到副行：状态读一个词就够，几点测的只是补充。
    sub: `上次 ${clockOf(test.at)}`,
    tone: test.ok ? 'ok' : 'error',
  };
}

function hostRow(
  host: SshHost,
  ctx: { inSession: boolean; pendingDelete?: string; test?: HostTest },
): PluginPanelTableRow {
  const cells: Record<string, PluginPanelTableCell> = {
    // 名称是这一行的主角，地址是它的补充：合成一格两行，别让地址单独占一列把整行撑开。
    server: { text: host.id, sub: `${host.user}@${host.host}:${host.port}` },
    status: statusCell(ctx.test),
    session: {
      check: { checked: ctx.inSession, action: 'toggle-session' },
    },
    auto: {
      check: { checked: host.autoAdd === true, action: 'toggle-auto' },
    },
  };
  const actions =
    ctx.pendingDelete === host.id
      ? [
          { id: 'confirm-delete', label: '确认删除', tone: 'danger' as const },
          { id: 'cancel-delete', label: '取消', tone: 'ghost' as const },
        ]
      : [
          { id: 'edit', label: '编辑' },
          { id: 'delete', label: '删除', tone: 'danger' as const },
        ];
  return { key: host.id, cells, actions };
}

function draftSection(draft: Draft, dataDir: string, editing: boolean): PluginPanelSection {
  const hasPassword = editing && draft.id ? hasStoredPassword(draft.id, dataDir) : false;
  const isPassword = draft.auth === 'password';
  return {
    title: editing ? `编辑 · ${draft.id || '未命名'}` : '添加',
    subtitle: '填完点「连接」测一次：连上了会加进本次会话',
    fields: [
      { key: 'id', label: '别名', value: draft.id, placeholder: '测试机', hint: '模型用它指定机器，可用中文' },
      { key: 'host', label: '地址', value: draft.host, placeholder: '10.0.0.1 或 example.com' },
      { key: 'port', label: '端口', type: 'number', value: draft.port },
      { key: 'user', label: '用户名', value: draft.user || DEFAULT_SSH_USER, placeholder: DEFAULT_SSH_USER },
      {
        key: 'auth',
        label: '认证方式',
        type: 'select',
        value: draft.auth,
        options: [
          { value: 'password', label: '密码连接' },
          { value: 'key', label: 'SSH 私钥连接' },
        ],
      },
      ...(isPassword
        ? [
            {
              key: 'password',
              label: '密码',
              type: 'password' as const,
              value: '',
              placeholder: hasPassword ? '已保存（留空表示不改）' : '这台机器的登录密码',
              hint: '存进本插件数据目录的 0600 文件（明文），不进钥匙串、不进对话',
            },
          ]
        : [
            {
              key: 'keyPath',
              label: '私钥路径',
              value: draft.keyPath,
              placeholder: '~/.ssh/id_ed25519',
              hint: '留空则用 ~/.ssh/config 与 ssh-agent 里已有的配置',
            },
          ]),
    ],
    // 认证方式一改，字段集合就跟着换（密码 ↔ 私钥路径），所以这里也要在停顿后提交并
    // 重新取一次视图；顺带把已经填的地址存进草稿，切走再回来不会丢。
    commit: 'draft',
    // 底部只有一个按钮：填完就连接，不存在「先保存再测试」两步。
    actions: [
      { id: 'connect', label: '连接', tone: 'primary' },
      ...(editing ? [{ id: 'cancel', label: '取消编辑', tone: 'ghost' as const }] : []),
    ],
  };
}

export type PanelDeps = {
  ctx: RemoteContext;
  dataFile: string;
  /** 本次会话允许模型碰的机器。 */
  scope: SshScope;
  closeSession: (hostId: string) => void;
  /** 清单变了（加/删机器、改自动添加）：宿主据此重新注册工具。 */
  onHostsChange?: () => void;
};

export function createPanelHandler(deps: PanelDeps): PluginPanelHandler {
  const { ctx, dataFile, scope } = deps;
  const state = (): PanelState => readState(ctx.dataDir);
  const saveState = (next: PanelState): void => writeState(ctx.dataDir, { ...state(), ...next });

  const toggleSessionHost = (hostId: string, wanted: boolean): string => {
    const data = readData(dataFile);
    if (!data.hosts.some((host) => host.id === hostId)) return '这台服务器已经不在清单里了';
    // 第一次勾选时先按「自动添加」的默认值铺开，再加/减这一台：否则只勾一台会把别的
    // 自动机器全丢掉（那份默认值本来就该算进本次会话）。
    const base = scope.explicit() ?? scopedHosts(data, null).map((host) => host.id);
    const next = new Set(base);
    if (wanted) next.add(hostId);
    else next.delete(hostId);
    scope.set([...next]);
    return wanted
      ? `已把 ${hostId} 添加到本次会话：下一轮起模型能看到它`
      : `已从本次会话移除 ${hostId}：模型看不到它，也连不上`;
  };

  const toggleAutoHost = async (hostId: string, wanted: boolean): Promise<string> => {
    await mutateData(dataFile, (data) => {
      const hosts = data.hosts.map((entry) =>
        entry.id === hostId
          ? { ...entry, autoAdd: wanted, updatedAt: new Date().toISOString() }
          : entry,
      );
      if (!hosts.some((entry) => entry.id === hostId)) throw new Error(`没有叫 ${hostId} 的服务器`);
      return { data: { ...data, hosts }, result: undefined };
    });
    return wanted
      ? `${hostId}：以后新开的会话会自动带上它（当前会话不受影响）`
      : `${hostId}：新会话不再自动带上它`;
  };

  return {
    view(): PluginPanelView {
      const data = readData(dataFile);
      const current = state();
      const tests = current.tests ?? {};
      const inSession = new Set(scopedHosts(data, scope.explicit()).map((host) => host.id));
      const editingHost = current.editingId
        ? data.hosts.find((host) => host.id === current.editingId) ?? null
        : null;
      const draft = draftOf(editingHost, current);
      const editing = editingHost !== null;

      // 最近一次失败的原因留在服务器页：状态列只放一个词，读不出为什么连不上。
      const failed = data.hosts
        .map((host) => ({ host, test: tests[host.id] }))
        .filter((entry) => entry.test && !entry.test.ok)
        .sort((a, b) => (a.test?.at ?? '').localeCompare(b.test?.at ?? ''))
        .pop();

      const table: PluginPanelTable = {
        columns: [
          { key: 'server', label: '服务器', grow: true },
          { key: 'status', label: '状态' },
          { key: 'actions', label: '操作', actions: true },
          { key: 'session', label: '添加到会话' },
          { key: 'auto', label: '自动添加' },
        ],
        rows: data.hosts.map((host) =>
          hostRow(host, {
            inSession: inSession.has(host.id),
            ...(current.pendingDelete ? { pendingDelete: current.pendingDelete } : {}),
            ...(tests[host.id] ? { test: tests[host.id] } : {}),
          }),
        ),
      };

      const sections: PluginPanelSection[] = [
        {
          title: '服务器',
          subtitle: `${data.hosts.length} 台 · 本次会话 ${inSession.size} 台 · 模型${
            inSession.size > 0 ? '可以用' : '看不到'
          }`,
          ...(failed?.test
            ? {
                rows: [
                  {
                    label: `连不上（${failed.host.id}）`,
                    value: failed.test.message,
                    tone: 'error' as const,
                    wrap: true,
                  },
                ],
              }
            : {}),
          ...(table.rows.length > 0 ? { table } : {}),
          empty: '还没有服务器：在「添加」里填一台并点「连接」',
        },
        draftSection(draft, ctx.dataDir, editing),
      ];

      const labels = data.hosts.filter((host) => inSession.has(host.id)).map((host) => host.id);
      const latest = labels
        .map((id) => tests[id])
        .filter((entry): entry is HostTest => Boolean(entry))
        .sort((a, b) => a.at.localeCompare(b.at))
        .pop();
      return {
        title: 'SSH',
        subtitle: '远程服务器',
        // 状态条只在真的有一台能用时出现：一台都没添加时它只会多占一行「什么都没有」。
        ...(labels.length > 0
          ? {
              statusBar: {
                label: labels.length === 1 ? labels[0] : `${labels[0]} +${labels.length - 1}`,
                tone: latest ? (latest.ok ? ('ok' as const) : ('error' as const)) : ('muted' as const),
                detail: latest ? (latest.ok ? '已连接' : '连不上') : '未测试',
                section: '服务器',
              },
            }
          : {}),
        sections,
      };
    },

    async action(input): Promise<PluginPanelActionResult> {
      const current = state();
      const action = input.action;
      const values = input.values ?? {};
      const hostId = input.key ?? '';

      // 表格里的两列勾选：`values.check` 是勾完的状态，`values.column` 是点的那一列。
      if (action === 'toggle-session' || action === 'toggle-auto') {
        if (!hostId) return { message: '没有指明是哪台服务器' };
        const wanted = field(values, 'check') === 'true';
        if (action === 'toggle-session') return { message: toggleSessionHost(hostId, wanted) };
        try {
          return { message: await toggleAutoHost(hostId, wanted) };
        } catch (error) {
          return { message: error instanceof Error ? error.message : String(error) };
        }
      }

      // 表单输入先落进草稿：切认证方式、切别处再回来都不该丢已经敲进去的地址。
      // 密码**不**进草稿（`panel.json` 是普通文件），切走就没了——这是有意为之。
      if (action === 'draft') {
        // 面板不再收「用途」：编辑已有机器时保留它原来那个，别因为重开一次表单就清掉。
        const existing = current.editingId
          ? readData(dataFile).hosts.find((host) => host.id === current.editingId)
          : null;
        saveState({
          draft: {
            id: field(values, 'id'),
            host: field(values, 'host'),
            port: field(values, 'port') || '22',
            user: field(values, 'user'),
            label: field(values, 'label') || existing?.label || '',
            keyPath: field(values, 'keyPath'),
            auth: field(values, 'auth') === 'key' ? 'key' : 'password',
          },
        });
        // 自动提交只是把草稿同步过来，不是一次提交：口令不在草稿里（面板永不回填），
        // 若让页面按新视图重置表单，用户刚敲进去的密码会在停顿 0.5 秒后凭空消失。
        return { keepDrafts: true };
      }

      if (action === 'cancel') {
        saveState({ editingId: undefined, draft: undefined });
        return { message: '已取消编辑' };
      }
      if (action === 'cancel-delete') {
        saveState({ pendingDelete: undefined });
        return { message: '已取消' };
      }
      if (action === 'confirm-delete') {
        const target = current.pendingDelete;
        if (!target) return { message: '没有待确认的删除' };
        await mutateData(dataFile, (data) => {
          const next = data.hosts.filter((entry) => entry.id !== target);
          if (next.length === data.hosts.length) throw new Error(`没有叫 ${target} 的服务器`);
          return { data: { ...data, hosts: next }, result: target };
        });
        deletePassword(target, ctx.dataDir);
        deps.closeSession(target);
        // 删掉的机器也要从本次会话里去掉，否则那份清单会留着一个指向不存在机器的 id。
        const explicit = scope.explicit();
        if (explicit?.includes(target)) scope.set(explicit.filter((id) => id !== target));
        const tests = { ...(current.tests ?? {}) };
        delete tests[target];
        saveState({ pendingDelete: undefined, editingId: undefined, draft: undefined, tests });
        deps.onHostsChange?.();
        return { message: `已删除 ${target}` };
      }
      if (action === 'connect') {
        try {
          return { message: await connect(values) };
        } catch (error) {
          // 失败时保留表单：改个端口、修个拼写再点一次「连接」，不该从空白开始重填。
          return {
            message: `连接失败：${error instanceof Error ? error.message : String(error)}`,
            keepDrafts: true,
          };
        }
      }

      const host = readData(dataFile).hosts.find((entry) => entry.id === hostId);
      if (!host) return { message: '这台服务器已经不在清单里了' };

      if (action === 'edit') {
        saveState({
          editingId: host.id,
          pendingDelete: undefined,
          draft: {
            id: host.id,
            host: host.host,
            port: String(host.port),
            user: host.user,
            label: host.label ?? '',
            keyPath: host.keyPath ?? '',
            auth: host.auth,
          },
        });
        return { message: `正在编辑 ${host.id}` };
      }
      if (action === 'delete') {
        saveState({ pendingDelete: host.id });
        return { message: `再点一次「确认删除」才会删掉 ${host.id}（密码也一起清掉）` };
      }
      return { message: `不认识的动作：${action}` };
    },
  };

  /** 保存 + 测试一次走完：这是面板唯一的提交动作，也是「连上了才算配好」的唯一判据。 */
  async function connect(values: Record<string, string>): Promise<string> {
    const auth: SshAuth = field(values, 'auth') === 'key' ? 'key' : 'password';
    const password = String(values.password ?? '');
    const id = field(values, 'id');

    const outcome = await mutateData(dataFile, (data) => {
      const result = upsertHost(data, {
        id,
        host: field(values, 'host'),
        // 留空就当 root：表单默认已经填好了，清空只能是手滑。
        user: field(values, 'user') || DEFAULT_SSH_USER,
        port: field(values, 'port') || 22,
        auth,
        keyPath: field(values, 'keyPath'),
        // 「用途」已经从表单里去掉：编辑已有机器时沿用原值，新机器就是空。
        label: data.hosts.find((entry) => entry.id === id)?.label ?? '',
        readOnly: data.hosts.find((entry) => entry.id === id)?.readOnly === true,
      });
      return { data: result.data, result };
    });

    if (auth === 'password') {
      if (password) storePassword(outcome.host.id, password, ctx.dataDir);
      else if (!hasStoredPassword(outcome.host.id, ctx.dataDir)) {
        throw new Error('密码认证要先填一次密码（只存本机 0600 文件，不会给模型看）');
      }
    } else {
      // 换成私钥就删掉旧密码：留着只会让下次误以为密码认证还能用。
      deletePassword(outcome.host.id, ctx.dataDir);
    }

    deps.closeSession(outcome.host.id);
    saveState({ editingId: undefined, draft: undefined });

    const result = await testConnection(ctx, outcome.host);
    const fingerprint = result.fingerprint ?? readHostFingerprint(ctx, outcome.host);
    if (result.ok && fingerprint && fingerprint !== outcome.host.fingerprint) {
      await mutateData(dataFile, (data) => {
        const hosts = data.hosts.map((entry) =>
          entry.id === outcome.host.id ? { ...entry, fingerprint, updatedAt: new Date().toISOString() } : entry,
        );
        return { data: { ...data, hosts }, result: undefined };
      });
    }
    saveState({
      tests: {
        ...(readState(ctx.dataDir).tests ?? {}),
        [outcome.host.id]: {
          at: new Date().toISOString(),
          ok: result.ok,
          message: result.ok ? `连接成功 · ${result.message}` : result.message,
          ...(fingerprint ? { fingerprint } : {}),
        },
      },
    });
    deps.onHostsChange?.();
    if (!result.ok) throw new Error(result.message);

    // 新机器第一次连上就顺手加进本次会话：用户刚填完地址、点了连接，意图很清楚。
    const explicit = currentInSession(outcome.host.id);
    return `已连接 ${outcome.host.id}：${result.message}${fingerprint ? ` · 指纹 ${fingerprint}` : ''}${explicit}`;
  }

  function currentInSession(hostId: string): string {
    const data = readData(dataFile);
    const set = new Set(scopedHosts(data, scope.explicit()).map((host) => host.id));
    if (set.has(hostId)) return '';
    set.add(hostId);
    scope.set([...set]);
    return '（已加入本次会话）';
  }
}
