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
import { mutateData, readData, upsertHost, type SshHost } from './Hosts.js';
import { forgetHostKey, readHostFingerprint, testConnection, type RemoteContext } from './Remote.js';
import { deletePassword, hasStoredPassword, secretsLocation, storePassword } from './Secrets.js';

/**
 * 配置面板：插件给数据、宿主画出来（`display: 'modal'`）。
 *
 * 为什么口令是面板独有的输入：模型永远不该看到它——一旦进了工具参数，它就进了会话文件、
 * 进了下一次请求的上下文，还会被导出、被截图。所以 `ssh_hosts` 工具只能建「密码认证的
 * 主机」，口令这一步留给人在这里（或 Keychain 里）完成。
 *
 * 面板被反复调用（每次动作后宿主重新取视图），所以 `view()` 只读文件、不跑外部命令；
 * 唯一会连服务器的是 `test` 动作，结果写回 panel.json 再展示。
 */

export const PANEL_STATE_FILE = 'panel.json';

type LastTest = { hostId: string; at: string; ok: boolean; message: string; fingerprint?: string };

type PanelState = {
  editingId?: string;
  pendingDelete?: string;
  lastTest?: LastTest;
};

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

function hostSummary(host: SshHost, dataDir: string): string {
  const bits = [host.label || host.host];
  bits.push(host.auth === 'password' ? (hasStoredPassword(host.id, dataDir) ? '密码认证' : '密码未填') : host.auth === 'key' ? '私钥' : 'agent');
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
      { id: 'test', label: '测试' },
      { id: 'edit', label: '编辑' },
      { id: 'delete', label: '删除', tone: 'danger' as const },
    ],
  }));
}

function draftSection(host: SshHost | null, dataDir: string): PluginPanelSection {
  const editing = host !== null;
  const hasPassword = host ? hasStoredPassword(host.id, dataDir) : false;
  return {
    title: host ? `编辑 ${host.id}` : '添加服务器',
    subtitle: host ? '改完点一种认证方式保存' : '地址、账号、认证方式；口令只进钥匙串',
    fields: [
      { key: 'id', label: '别名', value: host?.id ?? '', placeholder: 'test' },
      { key: 'host', label: '地址', value: host?.host ?? '', placeholder: '10.0.0.1 或 example.com' },
      { key: 'port', label: '端口', type: 'number', value: String(host?.port ?? 22) },
      { key: 'user', label: '用户名', value: host?.user ?? '', placeholder: 'root' },
      { key: 'label', label: '用途', value: host?.label ?? '', placeholder: '测试机 / 生产 API' },
      {
        key: 'keyPath',
        label: '私钥路径',
        value: host?.keyPath ?? '',
        placeholder: '~/.ssh/id_ed25519',
        hint: '只在用私钥时必须填；走 ssh config 认证时留空',
      },
      {
        key: 'password',
        label: '口令',
        type: 'password',
        value: '',
        placeholder: hasPassword ? '已保存（留空表示不改）' : '只在密码认证时填',
        hint: '存进 macOS 钥匙串，不写进清单文件，也不会给模型看到',
      },
    ],
    actions: [
      { id: 'save-password', label: '用密码保存', tone: 'primary' },
      { id: 'save-key', label: '用私钥保存' },
      { id: 'save-agent', label: '用 ssh config 保存' },
      ...(editing ? [{ id: 'cancel', label: '取消编辑', tone: 'ghost' as const }] : []),
      ...(host && host.fingerprint ? [{ id: 'retrust', label: '重新信任主机密钥', tone: 'ghost' as const }] : []),
    ],
  };
}

export type PanelDeps = {
  ctx: RemoteContext;
  dataFile: string;
  closeSession: (hostId: string) => void;
};

export function createPanelHandler(deps: PanelDeps): PluginPanelHandler {
  const { ctx, dataFile } = deps;
  const state = (): PanelState => readState(ctx.dataDir);
  const saveState = (next: PanelState): void => writeState(ctx.dataDir, { ...state(), ...next });

  async function saveHost(values: Record<string, string>, auth: 'password' | 'key' | 'agent'): Promise<string> {
    const id = field(values, 'id');
    const password = String(values?.password ?? '');
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
        saveState({ editingId: undefined });
            return `${outcome.host.id} 已保存，但还没有口令：在上面填一次「口令」再保存（或再点一次「用密码保存」）`;
      }
    } else {
      // 换了认证方式：留着旧口令没有意义，还会让下次误以为它能用。
      deletePassword(outcome.host.id, ctx.dataDir);
    }
    deps.closeSession(outcome.host.id);
    saveState({ editingId: undefined, lastTest: undefined });
    return `${outcome.created ? '已添加' : '已更新'} ${outcome.host.id}（${outcome.host.user}@${outcome.host.host}:${outcome.host.port}）`;
  }

  return {
    view(): PluginPanelView {
      const data = readData(dataFile);
      const current = state();
      const editing = current.editingId ? data.hosts.find((host) => host.id === current.editingId) ?? null : null;
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
          label: `上次测试（${current.lastTest.hostId}）`,
          value: `${clockOf(current.lastTest.at)} · ${current.lastTest.ok ? '通过' : '失败'}：${current.lastTest.message}`,
          tone: current.lastTest.ok ? 'ok' : 'error',
          wrap: true,
        });
      }

      const audit = readAudit(ctx.dataDir, 12);
      const sections: PluginPanelSection[] = [
        {
          title: '服务器',
          subtitle: `${data.hosts.length} 台`,
          items: hostItems(ctx.dataDir, data.hosts, current.lastTest),
          empty: '还没有服务器：在「添加服务器」里填一台',
          actions: current.pendingDelete
            ? [
                { id: 'confirm-delete', label: `确认删除 ${current.pendingDelete}`, tone: 'danger' },
                { id: 'cancel-delete', label: '取消', tone: 'ghost' },
              ]
            : [],
        },
        draftSection(editing, ctx.dataDir),
        {
          title: '最近操作',
          subtitle: '模型与面板发起的远程调用',
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
      return { title: 'SSH', subtitle: '远程服务器', sections };
    },

    async action(input): Promise<PluginPanelActionResult> {
      const current = state();
      const action = input.action;
      if (action === 'cancel') {
        saveState({ editingId: undefined });
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
            saveState({ pendingDelete: undefined, editingId: undefined });
        return { message: `已删除 ${target}` };
      }
      if (action === 'save-password' || action === 'save-key' || action === 'save-agent') {
        const auth = action === 'save-password' ? 'password' : action === 'save-key' ? 'key' : 'agent';
        try {
          return { message: await saveHost(input.values ?? {}, auth) };
        } catch (error) {
          return { message: `保存失败：${error instanceof Error ? error.message : String(error)}` };
        }
      }

      const hostId = input.key ?? '';
      const host = readData(dataFile).hosts.find((entry) => entry.id === hostId);
      if (!host) return { message: '这台服务器已经不在清单里了' };

      if (action === 'edit') {
        saveState({ editingId: host.id, pendingDelete: undefined });
        return { message: `正在编辑 ${host.id}` };
      }
      if (action === 'delete') {
        saveState({ pendingDelete: host.id });
        return { message: `再点一次「确认删除 ${host.id}」才会删除（口令也一起清掉）` };
      }
      if (action === 'retrust') {
        forgetHostKey(ctx, host);
        saveState({ lastTest: undefined });
        return { message: `已清除 ${host.id} 的主机指纹：下次连接会重新记录（确认这台机器是你自己的再继续）` };
      }
      if (action === 'test') {
        const result = await testConnection(ctx, host);
        const fingerprint = result.fingerprint ?? readHostFingerprint(ctx, host);
        if (result.ok && fingerprint && fingerprint !== host.fingerprint) {
          await mutateData(dataFile, (data) => {
            const hosts = data.hosts.map((entry) =>
              entry.id === host.id ? { ...entry, fingerprint, updatedAt: new Date().toISOString() } : entry,
            );
            return { data: { ...data, hosts }, result: undefined };
          });
              }
        saveState({
          lastTest: {
            hostId: host.id,
            at: new Date().toISOString(),
            ok: result.ok,
            message: result.ok ? `连接成功 · ${result.message}` : result.message,
            ...(fingerprint ? { fingerprint } : {}),
          },
        });
        return {
          message: result.ok
            ? `连接成功：${result.message}${fingerprint ? ` · 指纹 ${fingerprint}` : ''}`
            : `连接失败：${result.message}`,
        };
      }
      return { message: `不认识的动作：${action}` };
    },
  };
}
