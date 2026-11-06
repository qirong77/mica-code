import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveLogDir } from '@packages/mica-config/brand.js';
import type { PluginContext } from '@packages/mica-plugin/index.js';
import type {
  PluginPanelAction,
  PluginPanelActionResult,
  PluginPanelHandler,
  PluginPanelRow,
  PluginPanelSection,
  PluginPanelView,
} from '@packages/mica-plugin/index.js';
import { buildStatus, readBridgePid, type BridgeStatus } from './BridgeSupervisor.js';
import { findRendererDir, readDeployState, runSetup } from './DeployRunner.js';
import { guidePageSync, rendererDirFor, skillPathFor } from './PageSyncAction.js';
import { machineIdentity } from './Registrar.js';
import { registerMachine } from './registerMachine.js';

/**
 * 对话右侧那块面板：看现在通没通、接中转机、首次部署，全部点按钮完成。
 *
 * 三块的分工要立住：**概览**只回答「手机现在能不能用、链接是什么」；**接入**是日常那一步
 * （填中转地址、注册、试连）；**首次部署**是「中转机上还什么都没有」时才用的一次性操作。
 * 早先它们和平铺的页面版本、注册、部署、说明挤成六块，点开第一眼看到的是部署细节。
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
  enrollKey: '',
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

type SupervisorStatus = Partial<BridgeStatus>;

/** 常驻监管写的那份状态：面板只读它，不自己去问中转机。 */
function readSupervisorStatus(dataDir: string | null): SupervisorStatus {
  if (!dataDir) return {};
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, 'data.json'), 'utf8')) as SupervisorStatus;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * 现在这一刻的状态。
 *
 * 优先读监管写下的那份（它探过中转机、知道手机在不在线）；文件还没生成时按设置现算一份
 * ——刚装好插件、桥还没跑起来时也该看到「未配置 / 未运行」，而不是一张空面板。
 */
function liveStatus(ctx: PluginContext, dataDir: string | null): BridgeStatus {
  const values = ctx.settings.get();
  const fallback = buildStatus(values, null, readBridgePid(dataDir), Date.now());
  const stored = readSupervisorStatus(dataDir);
  // 逐字段取：data.json 可能只写过其中几行（旧版本、或测试里手写的状态），缺的那几行
  // 用现算值补上，而不是整份退回——否则「页面落后」会因为桥那行缺席一起消失。
  const pick = (key: 'bridge' | 'relay' | 'phone' | 'page') => {
    const line = stored[key];
    return line && typeof line.text === 'string' ? line : fallback[key];
  };
  return {
    ...fallback,
    ...stored,
    bridge: pick('bridge'),
    relay: pick('relay'),
    phone: pick('phone'),
    page: pick('page'),
  };
}

/**
 * 概览：手机现在能不能用、链接是什么、哪儿不对。
 *
 * 链接放第一行并且带 `link`：这是整个面板唯一「拿到就能用」的东西，不该埋在状态表里。
 * 页面落后仍留一个「更新」按钮——手机打开的就是中转机上那份，用户没有别的入口能换掉它。
 */
function overviewSection(ctx: PluginContext, dataDir: string | null): PluginPanelSection {
  const status = liveStatus(ctx, dataDir);
  const configured = Boolean(String(ctx.settings.get().relayUrl ?? '').trim());
  const stale = typeof status.pageKey === 'string' && status.pageKey.length > 0;
  const rows: PluginPanelRow[] = [
    { label: '本机桥', value: status.bridge.text, tone: status.bridge.tone },
    { label: '中转机', value: status.relay.text, tone: status.relay.tone },
    { label: '手机', value: status.phone.text, tone: status.phone.tone },
    { label: '页面版本', value: status.page.text, tone: status.page.tone },
  ];
  if (status.phoneUrl) {
    rows.unshift({ label: '手机链接', value: status.phoneUrl, tone: 'accent', link: status.phoneUrl });
  }
  return {
    title: '概览',
    text: status.phoneUrl
      ? '在手机上打开这个链接：同一份会话、同样的流式输出。这台机器退出 Mica 时手机打不开。'
      : configured
        ? '中转地址已经填好，还差一个口令：到「接入」里点一次「注册这台机器」，手机链接就会出现。'
        : '还没接入：到「接入」里填中转地址并注册。中转机上还什么都没装的话，看「首次部署」。',
    rows,
    actions: [
      {
        id: 'sync-page',
        label: '更新中转机页面',
        tone: stale ? 'primary' : 'ghost',
        disabled: !configured,
        hint: '手机打开的是中转机上那份页面；本机升级后版本会落后',
      },
      { id: 'request-logs', label: '查看请求日志', hint: '只记录请求元数据，不包含口令和正文' },
    ],
  };
}

/**
 * 首次部署：中转机上还没有这份运行时的时候走一次。
 *
 * 日常「已经装过、只想把这台机器接上」不经过这里——那一步在「接入」里，不需要 SSH。
 * 部署输出放在这块正文里：运行中它是最该看的东西，而失败时原因就在最后几行。
 */
function deploySection(ctx: PluginContext, dataDir: string | null, drafts: Drafts): PluginPanelSection {
  const deploy = readDeployState(dataDir);
  const renderer = findRendererDir(drafts.renderer);
  const running = deploy.phase === 'running';
  const configured = Boolean(String(ctx.settings.get().relayUrl ?? '').trim());

  const actions: PluginPanelAction[] = [
    {
      id: 'apply',
      label: configured ? '接入这台机器' : '部署中转机',
      tone: 'primary',
      disabled: running || !drafts.sshHost.trim(),
      hint: '装过中转机就只登记本机，否则走完整部署',
    },
  ];
  // 找不到页面产物就没法在本机打包上传：把这一轮整个交给 agent，它自己取仓库、构建、部署。
  if (!renderer) {
    actions.push({
      id: 'ask-agent',
      label: '让 agent 构建并部署',
      tone: 'ghost',
      hint: '开一轮去取仓库、构建页面产物、部署中转机并回填设置',
    });
  }

  return {
    title: '首次部署',
    subtitle: '在中转机上装好 Mica 运行时；装过就不用再来这里',
    text: deploy.lines.length > 0 ? deploy.lines.slice(-12).join('\n') : undefined,
    rows: [
      {
        label: '页面产物',
        value: renderer ? renderer : '没找到（部署需要它）',
        tone: renderer ? 'ok' : 'warn',
      },
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

/**
 * 注册：只需一个中转地址，口令由插件自己拿到并写回设置。
 *
 * 同一台机器重复点拿到的是同一个口令（中转机按机器标识认领），所以这个按钮
 * 点了也没有副作用——重装插件、换会话都不用重新理解什么。
 */
function accessSection(ctx: PluginContext, drafts: Drafts): PluginPanelSection {
  const values = ctx.settings.get();
  const settingsUrl = String(values.relayUrl ?? '').trim();
  const token = String(values.token ?? '').trim();
  const machine = machineIdentity();
  const registered = token.length >= 16;
  const relayUrl = drafts.relayUrl || settingsUrl;

  return {
    title: '接入',
    subtitle: `${machine.label} · ${machine.platform}`,
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
      { id: 'test', label: '测试连接', disabled: !relayUrl, hint: '只请求一次 /api/health' },
    ],
  };
}

export function buildPanelView(ctx: PluginContext, dataDir: string | null): PluginPanelView {
  const drafts = readDrafts(dataDir);
  const deploy = readDeployState(dataDir);
  const configured = Boolean(String(ctx.settings.get().relayUrl ?? '').trim());

  const sections: PluginPanelSection[] = [
    overviewSection(ctx, dataDir),
    accessSection(ctx, drafts),
    deploySection(ctx, dataDir, drafts),
  ];

  const tone =
    deploy.phase === 'running' ? 'accent' : deploy.phase === 'failed' ? 'error' : configured ? 'ok' : 'muted';

  return {
    title: '手机访问',
    subtitle: '手机打开这台机器上的 Mica：同一份会话，本机只做出站轮询。',
    status: {
      label:
        deploy.phase === 'running'
          ? '正在部署'
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

/**
 * 「手机访问」入口的弹窗：接好了就给一张二维码，没接好就把人送到插件页面。
 *
 * 链接由设置现算（`buildStatus` 是面板、状态行、状态文件的同一份规则），不读
 * `data.json` 里上次落盘的值：刚注册完、桥还没轮询过一次时，缓存里那份还是旧口令。
 * 二维码只放内容，编码与尺寸交给宿主——插件不该为了画一个码背一个编码器。
 */
function phoneDialog(ctx: PluginContext): PluginPanelActionResult {
  const status = buildStatus(ctx.settings.get(), null, null, Date.now());
  if (!status.phoneUrl) {
    return {
      dialog: {
        title: '手机访问',
        text: '还没接入。到插件页面填中转地址、点一次「注册这台机器」，这里就会出现可以扫的二维码。',
        configure: { label: '去插件页面配置' },
        // 首次部署（中转机上还什么都没有）只在面板里做：给一个次要入口，别把一个
        // 一次性操作藏进没人知道怎么打开的地方。
        panel: { label: '首次部署' },
      },
    };
  }
  return {
    dialog: {
      title: '手机访问',
      subtitle: '手机扫码打开这台机器上的 Mica',
      qr: {
        value: status.phoneUrl,
        caption: '同一份会话、同样的流式输出；本机只做出站轮询。',
      },
    },
  };
}

export function createPanelHandler(ctx: PluginContext, dataDir: string | null): PluginPanelHandler {
  return {
    view() {
      return buildPanelView(ctx, dataDir);
    },

    async action({ action, values }) {
      if (!dataDir) throw new Error('没有插件数据目录，检查 MICA_HOME 是否可写');

      // 入口动作（清单 `desktop.panel.open`）：点了「手机访问」只要一个二维码，不打开抽屉。
      // 它必须在 saveDrafts 之前返回——页面没有表单可提交，落一次草稿会把用户填了一半的
      // 中转地址与 SSH 全部清空。
      if (action === 'show') return phoneDialog(ctx);

      if (action === 'request-logs') {
        const dir = resolveLogDir();
        mkdirSync(dir, { recursive: true });
        const files = readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => ({
            name: entry.name,
            match: /^relay-requests-(\d{8})(?:-([1-9]\d{0,8}))?\.jsonl$/.exec(entry.name),
          }))
          .filter((entry) => entry.match)
          .sort(
            (a, b) => a.match![1]!.localeCompare(b.match![1]!) || Number(a.match![2] || 0) - Number(b.match![2] || 0),
          );
        return { openPath: { path: files.length ? join(dir, files.at(-1)!.name) : dir } };
      }

      const drafts = saveDrafts(dataDir, values ?? {});

      if (action === 'ask-agent') {
        const runtime = ctx.runtime;
        if (!runtime) throw new Error('当前宿主不能发起会话');
        const host = drafts.sshHost || '中转机';
        await runtime.submit(
          `用 mobile-relay-setup skill 帮我把手机访问配好：中转机是 ${host}。` +
            '仓库里没有页面产物就先构建，再跑 setup.mjs 完成部署，并把地址与口令写回插件设置。',
        );
        return { message: '已交给 agent，进展看对话' };
      }

      if (action === 'test') {
        const url = String(ctx.settings.get().relayUrl ?? '')
          .trim()
          .replace(/\/+$/, '');
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
        return registerMachine(ctx, { relayUrl, enrollKey: drafts.enrollKey, label: drafts.label }, dataDir);
      }

      if (action === 'sync-page') {
        // 只把提示词交给宿主：新会话、输入框、按不按回车都由页面与用户决定。
        return guidePageSync({ skillPath: skillPathFor(dataDir), rendererDir: rendererDirFor(ctx) });
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
          },
        );
        if (state.phase === 'ok') return { message: '完成，手机链接见「状态」一节' };
        throw new Error(state.lines[state.lines.length - 1] || '部署失败，看「过程」一节');
      }

      throw new Error(`未知动作：${action}`);
    },
  };
}
