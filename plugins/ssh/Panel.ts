import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PluginPanelActionResult,
  PluginPanelHandler,
  PluginPanelItem,
  PluginPanelRow,
  PluginPanelSection,
  PluginPanelView,
} from '@packages/mica-plugin/index.js';
import { readAudit } from './Audit.js';
import { mutateData, readData, upsertHost, type SshAuth, type SshHost } from './Hosts.js';
import { readHostFingerprint, testConnection, type RemoteContext } from './Remote.js';
import { deletePassword, hasStoredPassword, secretsLocation, storePassword } from './Secrets.js';

/**
 * 配置面板：插件给数据、宿主画出来（`display: 'modal'`）。
 *
 * 三种东西各占一块：**开关**（这个插件现在是否对模型生效）、**机器清单**（逐台增删改）、
 * **连接设置**（表单 + 一个「连接」按钮）。
 *
 * 口令是这个面板独有的输入，也是唯一**不回填**的字段：`view()` 里它永远是空串（提示写
 * 「已保存」），动作提交后再写进 `Secrets.ts` 的 0600 文件。所以页面、截图、分享出去的
 * 界面里都不会出现口令，模型更是从头到尾只看到主机别名。
 *
 * 面板会被反复调用（每次动作后宿主重新取视图），所以 `view()` 只读文件、不跑外部命令；
 * 唯一会连服务器的是「连接」与逐台的「测试」。
 */

export const PANEL_STATE_FILE = 'panel.json';

type LastTest = { hostId: string; at: string; ok: boolean; message: string; fingerprint?: string };

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
  lastTest?: LastTest;
};

function emptyDraft(): Draft {
  return { id: '', host: '', port: '22', user: '', label: '', keyPath: '', auth: 'password' };
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
  if (draft && (!host || draft.id === host.id)) return draft;
  if (!host) return emptyDraft();
  return {
    id: host.id,
    host: host.host,
    port: String(host.port),
    user: host.user,
    label: host.label ?? '',
    keyPath: host.keyPath ?? '',
    auth: host.auth,
  };
}

function hostSummary(host: SshHost, dataDir: string): string {
  const bits = [host.label || host.host];
  if (host.auth === 'password') {
    bits.push(hasStoredPassword(host.id, dataDir) ? '密码认证' : '密码未填');
  } else {
    bits.push(host.keyPath ? '私钥' : '私钥 / ssh config');
  }
  if (host.readOnly) bits.push('只读');
  if (host.fingerprint) bits.push('已固定指纹');
  return bits.join(' · ');
}

function hostItems(dataDir: string, hosts: SshHost[], lastTest?: LastTest): PluginPanelItem[] {
  return hosts.map((host) => ({
    key: host.id,
    label: `${host.id} — ${host.user}@${host.host}:${host.port}`,
    value: `${hostSummary(host, dataDir)}${lastTest?.hostId === host.id ? ` · 上次测试${lastTest.ok ? '通过' : '失败'}` : ''}`,
    ...(lastTest?.hostId === host.id ? { tone: lastTest.ok ? ('ok' as const) : ('error' as const) } : {}),
    actions: [
      { id: 'edit', label: '编辑' },
      { id: 'delete', label: '删除', tone: 'danger' as const },
    ],
  }));
}

function draftSection(draft: Draft, dataDir: string, editing: boolean): PluginPanelSection {
  const hasPassword = editing && draft.id ? hasStoredPassword(draft.id, dataDir) : false;
  const isPassword = draft.auth === 'password';
  return {
    title: editing ? `连接设置 · ${draft.id || '未命名'}` : '连接设置 · 新服务器',
    subtitle: '填完点「连接」，连上了才保存',
    fields: [
      { key: 'id', label: '别名', value: draft.id, placeholder: 'test', hint: '模型用它指定机器，只用字母数字与 . _ -' },
      { key: 'host', label: '地址', value: draft.host, placeholder: '10.0.0.1 或 example.com' },
      { key: 'port', label: '端口', type: 'number', value: draft.port },
      { key: 'user', label: '用户名', value: draft.user, placeholder: 'root' },
      { key: 'label', label: '用途', value: draft.label, placeholder: '测试机 / 生产 API' },
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
              label: '口令',
              type: 'password' as const,
              value: '',
              placeholder: hasPassword ? '已保存（留空表示不改）' : '这台机器的登录口令',
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
    // 认证方式一改，字段集合就跟着换（口令 ↔ 私钥路径），所以这里也要在停顿后提交并
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
  closeSession: (hostId: string) => void;
  /** 开关变了：宿主据此注册/注销工具。不传就只有面板自己的状态变。 */
  onEnabledChange?: (enabled: boolean) => void;
};

export function createPanelHandler(deps: PanelDeps): PluginPanelHandler {
  const { ctx, dataFile } = deps;
  const state = (): PanelState => readState(ctx.dataDir);
  const saveState = (next: PanelState): void => writeState(ctx.dataDir, { ...state(), ...next });

  return {
    view(): PluginPanelView {
      const data = readData(dataFile);
      const current = state();
      const editingHost = current.editingId
        ? data.hosts.find((host) => host.id === current.editingId) ?? null
        : null;
      const draft = draftOf(editingHost, current);
      const editing = editingHost !== null;

      const rows: PluginPanelRow[] = [
        { label: '口令存放', value: secretsLocation(ctx.dataDir), wrap: true },
        { label: '连接复用', value: `同一台机器的连续命令复用一条连接（${ctx.persistSeconds}s 空闲后断开）` },
        { label: '输出', value: `默认只回最后 ${ctx.tailLines} 行，全文留在远端 /tmp` },
      ];
      if (current.pendingDelete) {
        rows.unshift({
          label: '待确认删除',
          value: `${current.pendingDelete} —— 点下面的「确认删除」才会真的删`,
          tone: 'warn',
        });
      }
      if (current.lastTest) {
        rows.push({
          label: `上次连接（${current.lastTest.hostId}）`,
          value: `${clockOf(current.lastTest.at)} · ${current.lastTest.ok ? '通过' : '失败'}：${current.lastTest.message}`,
          tone: current.lastTest.ok ? 'ok' : 'error',
          wrap: true,
        });
      }

      const audit = readAudit(ctx.dataDir, 12);
      const sections: PluginPanelSection[] = [
        {
          title: '状态',
          subtitle: data.enabled ? '模型可以使用' : '模型看不到',
          fields: [
            {
              key: 'enabled',
              label: '让模型使用这些服务器',
              type: 'switch',
              value: data.enabled ? 'true' : 'false',
              hint: data.enabled
                ? '开启中：ssh 工具已注册、主机清单已注入，输入框上方有状态栏'
                : '关闭中：会话里没有 ssh 工具，模型只知道「这个能力没开」',
            },
          ],
          // 开关就地生效：改完半秒内写盘并同步工具注册，不需要再点按钮。
          commit: 'toggle',
        },
        {
          title: '服务器',
          subtitle: `${data.hosts.length} 台`,
          items: hostItems(ctx.dataDir, data.hosts, current.lastTest),
          empty: '还没有服务器：在下面「连接设置」里填一台并点「连接」',
          actions: current.pendingDelete
            ? [
                { id: 'confirm-delete', label: `确认删除 ${current.pendingDelete}`, tone: 'danger' },
                { id: 'cancel-delete', label: '取消', tone: 'ghost' },
              ]
            : [],
        },
        draftSection(draft, ctx.dataDir, editing),
        {
          title: '最近操作',
          subtitle: '最近的脚本',
          items: audit.map((entry, index) => ({
            key: `${entry.at}-${index}`,
            label: `${clockOf(entry.at)} · ${entry.hostId} · ${entry.ok ? 'exit 0' : `exit ${entry.exitCode ?? '—'}`}`,
            value: entry.script,
            tone: entry.ok ? ('muted' as const) : ('warn' as const),
          })),
          empty: '还没有远程调用',
        },
        { title: '说明', rows, collapsed: true },
      ];
      return {
        title: 'SSH',
        subtitle: '远程服务器',
        // 状态栏只在生效时出现：关着的时候输入框上方不该多一行「有个功能关着」。
        ...(data.enabled
          ? {
              statusBar: {
                label: 'SSH 已启用',
                tone: 'ok' as const,
                detail:
                  data.hosts.length > 0
                    ? data.hosts.map((host) => host.id).join('、')
                    : '还没有服务器',
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

      // 表单输入先落进草稿：切认证方式、切别处再回来都不该丢已经敲进去的地址。
      // 口令**不**进草稿（`panel.json` 是普通文件），切走就没了——这是有意为之。
      if (action === 'draft') {
        saveState({
          draft: {
            id: field(values, 'id'),
            host: field(values, 'host'),
            port: field(values, 'port') || '22',
            user: field(values, 'user'),
            label: field(values, 'label'),
            keyPath: field(values, 'keyPath'),
            auth: field(values, 'auth') === 'key' ? 'key' : 'password',
          },
        });
        return {};
      }

      if (action === 'toggle') {
        const enabled = field(values, 'enabled') === 'true';
        const currentData = readData(dataFile);
        if (currentData.enabled === enabled) return { message: enabled ? '已经是开启状态' : '已经是关闭状态' };
        if (enabled && currentData.hosts.length === 0) {
          return { message: '先加一台服务器并连上，再打开开关' };
        }
        await mutateData(dataFile, (data) => ({ data: { ...data, enabled }, result: undefined }));
        deps.onEnabledChange?.(enabled);
        return {
          message: enabled
            ? '已开启：下一轮起模型能用 ssh_run / ssh_read / ssh_session'
            : '已关闭：会话里不再注册 ssh 工具，主机清单也不再注入',
        };
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
          const stillHasHosts = next.length > 0;
          // 删掉最后一台就没有可用的机器了：开关跟着关，否则状态栏写着「已启用」却什么都没配。
          return { data: { ...data, hosts: next, enabled: stillHasHosts ? data.enabled : false }, result: target };
        });
        deletePassword(target, ctx.dataDir);
        deps.closeSession(target);
        saveState({ pendingDelete: undefined, editingId: undefined, draft: undefined });
        if (readData(dataFile).hosts.length === 0) deps.onEnabledChange?.(false);
        return { message: `已删除 ${target}` };
      }
      if (action === 'connect') {
        try {
          return { message: await connect(values) };
        } catch (error) {
          return { message: `连接失败：${error instanceof Error ? error.message : String(error)}` };
        }
      }

      const hostId = input.key ?? '';
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
        return { message: `再点一次「确认删除 ${host.id}」才会删除（口令也一起清掉）` };
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
        user: field(values, 'user'),
        port: field(values, 'port') || 22,
        auth,
        keyPath: field(values, 'keyPath'),
        label: field(values, 'label'),
        readOnly: data.hosts.find((entry) => entry.id === id)?.readOnly === true,
      });
      return { data: result.data, result };
    });

    if (auth === 'password') {
      if (password) storePassword(outcome.host.id, password, ctx.dataDir);
      else if (!hasStoredPassword(outcome.host.id, ctx.dataDir)) {
        throw new Error('密码认证要先填一次口令（只存本机 0600 文件，不会给模型看）');
      }
    } else {
      // 换成私钥就删掉旧口令：留着只会让下次误以为密码认证还能用。
      deletePassword(outcome.host.id, ctx.dataDir);
    }

    deps.closeSession(outcome.host.id);
    saveState({
      editingId: undefined,
      draft: undefined,
      lastTest: undefined,
    });

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
      lastTest: {
        hostId: outcome.host.id,
        at: new Date().toISOString(),
        ok: result.ok,
        message: result.ok ? `连接成功 · ${result.message}` : result.message,
        ...(fingerprint ? { fingerprint } : {}),
      },
    });
    if (!result.ok) throw new Error(result.message);

    const enabled = readData(dataFile).enabled;
    return `已连接 ${outcome.host.id}：${result.message}${fingerprint ? ` · 指纹 ${fingerprint}` : ''}${
      enabled ? '' : '（打开上面的开关后模型才能使用）'
    }`;
  }
}
