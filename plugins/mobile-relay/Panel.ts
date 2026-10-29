import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import type {
  PluginPanelAction,
  PluginPanelHandler,
  PluginPanelRow,
  PluginPanelSection,
  PluginPanelView,
} from '@packages/mica-plugin/index.js';
import { buildStatus, readBridgePid } from './BridgeSupervisor.js';
import { findRendererDir, readDeployState, runSetup } from './DeployRunner.js';
import { machineIdentity } from './Registrar.js';
import { registerMachine } from './registerMachine.js';

/**
 * 对话右侧那块面板：接中转机、看状态、开关桥，全部点按钮完成。
 *
 * 插件只给数据，宿主负责画；动作回来时插件自己分派，做完宿主自动重新取一次视图。
 * `view()` 会被页面反复调用，所以这里只读文件，不跑外部命令。
 */

const FIELD_HOST = 'sshHost';
const FIELD_SSH_PORT = 'sshPort';
const FIELD_LABEL = 'label';
const FIELD_RENDERER = 'renderer';
const FIELD_RELAY = 'relayUrl';
const FIELD_ENROLL = 'enrollKey';

type Drafts = {
  sshHost: string;
  sshPort: string;
  label: string;
  renderer: string;
  relayUrl: string;
  enrollKey: string;
};

const EMPTY_DRAFTS: Drafts = {
  sshHost: '',
  sshPort: '22',
  label: '',
  renderer: '',
  relayUrl: '',
  enrollKey: ''
};

export function readDrafts(dataDir: string | null): Drafts {
  if (!dataDir) return { ...EMPTY_DRAFTS };
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, 'panel.json'), 'utf8')) as Partial<Drafts>;
    return {
      sshHost: typeof parsed.sshHost === 'string' ? parsed.sshHost : '',
      sshPort: typeof parsed.sshPort === 'string' && parsed.sshPort ? parsed.sshPort : '22',
      label: typeof parsed.label === 'string' ? parsed.label : '',
      renderer: typeof parsed.renderer === 'string' ? parsed.renderer : '',
      relayUrl: typeof parsed.relayUrl === 'string' ? parsed.relayUrl : '',
      enrollKey: typeof parsed.enrollKey === 'string' ? parsed.enrollKey : '',
    };
  } catch {
    return { ...EMPTY_DRAFTS };
  }
}

function saveDrafts(dataDir: string | null, values: Record<string, string>): Drafts {
  const next: Drafts = {
    sshHost: String(values[FIELD_HOST] ?? '').trim(),
    sshPort: String(values[FIELD_SSH_PORT] ?? '').trim() || '22',
    label: String(values[FIELD_LABEL] ?? '').trim(),
    renderer: String(values[FIELD_RENDERER] ?? '').trim(),
    relayUrl: String(values[FIELD_RELAY] ?? '').trim(),
    enrollKey: String(values[FIELD_ENROLL] ?? '').trim(),
  };
  if (dataDir) {
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, 'panel.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } catch {
      // 记不住也不影响这一次操作
    }
  }
  return next;
}

function statusRows(ctx: PluginContext, dataDir: string | null): PluginPanelRow[] {
  const values = ctx.settings.get();
  const relayUrl = String(values.relayUrl ?? '').trim();
  const pid = readBridgePid(dataDir);
  const status = buildStatus(values, null, pid, Date.now());
  const rows: PluginPanelRow[] = [
    { label: '中转地址', value: relayUrl || '未配置', tone: relayUrl ? 'ok' : 'muted' },
    { label: '本机桥', value: status.bridge.text, tone: status.bridge.tone },
  ];
  if (relayUrl && status.phoneUrl) {
    rows.push({ label: '手机链接', value: status.phoneUrl, tone: 'accent' });
  }
  return rows;
}

function setupSection(ctx: PluginContext, dataDir: string | null, drafts: Drafts): PluginPanelSection {
  const deploy = readDeployState(dataDir);
  const renderer = findRendererDir(drafts.renderer);
  const running = deploy.phase === 'running';
  const configured = Boolean(String(ctx.settings.get().relayUrl ?? '').trim());

  const actions: PluginPanelAction[] = [
    {
      id: 'apply',
      label: configured ? '接入这台机器' : '接入 / 部署',
      tone: 'primary',
      disabled: running || !drafts.sshHost.trim(),
      hint: '已经装过中转机时只登记这台机器；没装过会走完整部署（需要页面产物）。',
    },
    { id: 'test', label: '测试连接', disabled: !configured, hint: '只请求一次 /api/health' },
  ];

  return {
    title: '接中转机',
    collapsed: configured,
    rows: [
      {
        label: '页面产物',
        value: renderer ? renderer : '没找到（首次部署才需要）',
        tone: renderer ? 'ok' : 'warn',
      },
      ...(deploy.lines.length > 0
        ? [{ label: '最近输出', value: deploy.lines[deploy.lines.length - 1] ?? '', tone: 'muted' as const }]
        : []),
    ],
    fields: [
      {
        key: FIELD_HOST,
        label: '中转机 SSH',
        value: drafts.sshHost,
        placeholder: 'root@1.2.3.4',
        hint: '本机要能免密登录（先 ssh-copy-id）。地址栏填过一次就记住了。',
      },
      { key: FIELD_SSH_PORT, label: 'SSH 端口', value: drafts.sshPort, type: 'number', placeholder: '22' },
      {
        key: FIELD_LABEL,
        label: '这台机器的名字',
        value: drafts.label,
        placeholder: '留空用主机名',
        hint: '中转机按名字认领口令，同一台机器重跑不会留重复记录。',
      },
      {
        key: FIELD_RENDERER,
        label: '页面产物目录',
        value: drafts.renderer,
        placeholder: '留空自动查找',
        hint: '只有首次部署中转机时才需要；找不到就用下面「交给 agent」。',
      },
    ],
    actions,
  };
}

function askAgentSection(rendererFound: boolean): PluginPanelSection {
  return {
    title: '首次部署',
    collapsed: rendererFound,
    rows: [
      {
        label: rendererFound ? '可以直接部署' : '缺页面产物',
        value: rendererFound
          ? '点上面的「接入 / 部署」即可'
          : '页面产物是一份会随桌面端升级而过期的副本，所以不随插件分发。',
        tone: rendererFound ? 'ok' : 'warn',
      },
    ],
    items: rendererFound
      ? []
      : [
          {
            key: 'ask-agent',
            label: '交给 agent',
            value: '在这个会话里发起一轮：取仓库、构建页面产物、部署中转机、回填设置。',
            tone: 'accent',
            actions: [{ id: 'ask-agent', label: '让 agent 构建并部署', tone: 'primary' }],
          },
        ],
  };
}

/**
 * 注册：只需一个中转地址，口令由插件自己拿到并写回设置。
 *
 * 同一台机器重复点拿到的是同一个口令（中转机按机器标识认领），所以这个按钮
 * 点了也没有副作用——重装插件、换会话都不用重新理解什么。
 */
function registrationSection(ctx: PluginContext, drafts: Drafts): PluginPanelSection {
  const values = ctx.settings.get();
  const settingsUrl = String(values.relayUrl ?? '').trim();
  const token = String(values.token ?? '').trim();
  const machine = machineIdentity();
  const registered = token.length >= 16;
  const relayUrl = drafts.relayUrl || settingsUrl;

  return {
    title: '注册这台机器',
    collapsed: registered,
    rows: [
      { label: '这台机器', value: `${machine.label} · ${machine.platform}`, tone: 'muted' },
      {
        label: '注册状态',
        value: registered ? '已注册 · 再注册一次仍是这个口令' : '还没注册',
        tone: registered ? 'ok' : 'warn',
      },
    ],
    fields: [
      {
        key: FIELD_RELAY,
        label: '中转地址',
        value: relayUrl,
        placeholder: 'https://mica.example.com',
        hint: '填手机链接那个域名就行；不需要 SSH。已经部署过中转机的机器会自动带出来。',
      },
      {
        key: FIELD_ENROLL,
        label: '接入口令',
        value: drafts.enrollKey,
        placeholder: '中转机没口令就留空',
        hint: '只有中转机设了 enrollKey 才需要，默认没有。',
      },
    ],
    actions: [
      {
        id: 'register',
        label: registered ? '重新注册（同一个口令）' : '注册这台机器',
        tone: 'primary',
        disabled: !relayUrl,
        hint: '把本机标识加密发给中转机，换回一个口令并自动写入设置。',
      },
    ],
  };
}

export function buildPanelView(ctx: PluginContext, dataDir: string | null): PluginPanelView {
  const drafts = readDrafts(dataDir);
  const deploy = readDeployState(dataDir);
  const rendererFound = Boolean(findRendererDir(drafts.renderer));
  const configured = Boolean(String(ctx.settings.get().relayUrl ?? '').trim());

  const sections: PluginPanelSection[] = [
    { title: '状态', rows: statusRows(ctx, dataDir) },
    registrationSection(ctx, drafts),
    setupSection(ctx, dataDir, drafts),
    askAgentSection(rendererFound),
  ];

  if (deploy.lines.length > 0) {
    sections.push({
      title: '过程',
      collapsed: deploy.phase === 'ok',
      rows: deploy.lines.slice(-8).map((line) => ({ label: '', value: line })),
    });
  }

  const tone =
    deploy.phase === 'running'
      ? 'accent'
      : deploy.phase === 'failed'
        ? 'error'
        : configured
          ? 'ok'
          : 'muted';

  return {
    title: '手机访问',
    subtitle: '用手机打开这台机器上的 Mica：接入中转机、看状态、开关桥。',
    status: {
      label:
        deploy.phase === 'running'
          ? '正在处理'
          : deploy.phase === 'failed'
            ? '上次失败'
            : configured
              ? '已接入'
              : '未接入',
      tone,
    },
    sections,
  };
}

export function createPanelHandler(ctx: PluginContext, dataDir: string | null): PluginPanelHandler {
  return {
    view() {
      return buildPanelView(ctx, dataDir);
    },

    async action({ action, values }) {
      if (!dataDir) throw new Error('没有插件数据目录，检查 MICA_HOME 是否可写');
      const drafts = saveDrafts(dataDir, values ?? {});

      if (action === 'ask-agent') {
        const runtime = ctx.runtime;
        if (!runtime) throw new Error('当前宿主不能发起会话');
        const host = drafts.sshHost || '中转机';
        await runtime.submit(
          `用 mobile-relay-setup skill 帮我把手机访问配好：中转机是 ${host}。` +
            '仓库里没有页面产物就先构建，再跑 setup.mjs 完成部署，并把地址与口令写回插件设置。'
        );
        return { message: '已交给 agent，进展看对话' };
      }

      if (action === 'test') {
        const url = String(ctx.settings.get().relayUrl ?? '').trim().replace(/\/+$/, '');
        if (!url) throw new Error('还没配置中转地址');
        try {
          const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5_000) });
          if (!response.ok) throw new Error(`中转机返回 ${response.status}`);
          return { message: '中转机可达' };
        } catch (error) {
          throw new Error(`连不上：${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (action === 'register') {
        const relayUrl = drafts.relayUrl || String(ctx.settings.get().relayUrl ?? '').trim();
        return registerMachine(
          ctx,
          { relayUrl, enrollKey: drafts.enrollKey, label: drafts.label },
          dataDir
        );
      }

      if (action === 'apply') {
        if (!drafts.sshHost.trim()) throw new Error('先填中转机 SSH（形如 root@1.2.3.4）');
        const state = await runSetup(
          ctx,
          dataDir,
          {
            host: drafts.sshHost,
            sshPort: drafts.sshPort,
            label: drafts.label || undefined,
            renderer: drafts.renderer || undefined,
          },
          () => {
            // 进度落盘在 deploy.json，宿主下一次取视图就会读到
          }
        );
        if (state.phase === 'ok') return { message: '完成，手机链接见「状态」一节' };
        throw new Error(state.lines[state.lines.length - 1] || '部署失败，看「过程」一节');
      }

      throw new Error(`未知动作：${action}`);
    },
  };
}
