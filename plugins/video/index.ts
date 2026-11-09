import type { MicaPlugin, PluginContext } from '@packages/mica-plugin/index.js';
import type { FfmpegTools } from './ffmpeg.js';
import { cacheStats, defaultCacheRoot } from './frames.js';
import { formatBytes, publishStatus } from './status.js';
import { VideoFramesTool, warmUpFfmpeg } from './VideoFramesTool.js';

/**
 * 视频理解。
 *
 * 各家多模态模型目前都没有「原生视频输入」这个通用能力，Gemini 的 video 输入本质上也是
 * 服务端按秒抽帧。所以这里不做协议层的特判：**抽帧 → 走已有的图片链路**，内核一行都不用改
 * （`ToolResult` 本来就支持多图，两个 adapter 都会把工具返回的图片塞进下一次请求）。
 *
 * 可寻址的单位是时间而不是帧序号：下一轮的模型看不到上一轮返回的图片，`at: ["1:03"]` 才是
 * 自洽的引用方式。于是工具只有一条，两种用法——不给 at 是均匀概览，给了 at 是精确点名。
 */

const PLUGIN_ID = 'video';
const DEFAULT_MAX_EDGE = 1024;
const DEFAULT_CACHE_LIMIT_MB = 512;

const plugin: MicaPlugin = {
  id: PLUGIN_ID,
  name: 'Video',
  version: '1.0.0',
  priority: 205,
  required: false,

  setup(ctx: PluginContext) {
    const readConfig = () => ({
      ffmpegPath: String(ctx.settings.get().ffmpegPath ?? '').trim() || undefined,
      maxEdge: resolveNumber(ctx.settings.get().maxEdge, DEFAULT_MAX_EDGE),
      cacheLimitMb: resolveNumber(ctx.settings.get().cacheLimitMb, DEFAULT_CACHE_LIMIT_MB),
    });

    if (ctx.actions) {
      const action = ctx.actions.register('check', async ({ values }) => {
        const configuredPath =
          values.ffmpegPath === undefined ? readConfig().ffmpegPath : values.ffmpegPath.trim() || undefined;
        const tools = await refreshAvailability(ctx, configuredPath);
        return { message: tools ? `ffmpeg 可用：${tools.version}` : '仍然没有找到 ffmpeg' };
      });
      ctx.onDispose(() => action.dispose());
    }
    if (!ctx.tools) return;

    // 探测放在后台：装没装 ffmpeg 不该拖慢启动，而第一次调用自己也会探测一次。
    void refreshAvailability(ctx, readConfig().ffmpegPath);

    const issues = ctx.settings.validate();
    if (issues.length > 0) {
      ctx.health.report({
        level: 'warn',
        message: `配置有问题：${issues.map((issue) => `${issue.label} ${issue.message}`).join('；')}`,
        hint: '在配置页的 Plugins → Video 里修正。',
      });
    }

    const tool = new VideoFramesTool({
      getConfig: readConfig,
      onMissingFfmpeg: () => reportMissing(ctx),
    });
    const registration = ctx.tools.register(tool, { icon: '🎞️' });
    ctx.onDispose(() => registration.dispose());

    // 视频的用法没法靠 schema 描述讲清楚「先粗看再点名」，所以带一小段 prompt。
    // 只在插件启用时出现——插件停用之后模型不该还惦记一个不存在的工具。
    if (ctx.prompt) {
      const section = ctx.prompt.section({
        id: 'video',
        order: 60,
        render: () => VIDEO_PROMPT,
      });
      ctx.onDispose(() => section.dispose());
    }

    ctx.logger.info('video:ready', readConfig());
  },
};

const VIDEO_PROMPT = [
  '## 理解视频',
  '',
  '- 用户给出视频文件或链接、并问「里面发生了什么」时，用 `video_frames` 抽帧来看，不要猜内容。',
  '- 先只传 `source` 拿 4 帧概览与时长，再按返回的时间轴用 `at` 精确点名要看的那几秒。除非用户已经指明时间点，不要一上来就一次要满帧数。',
  '- 引用画面时说时间点（"在 4:50 处"），不要说「第几帧」——帧序号在后续轮次里没有意义。',
  '- 音轨不会被转写。用户问的是「说了什么」而不是「画面是什么」时，先说明这一点，再决定要不要抽帧看画面上的字幕或标注。',
].join('\n');

async function refreshAvailability(
  ctx: PluginContext,
  configuredPath: string | undefined,
): Promise<FfmpegTools | null> {
  const tools = await warmUpFfmpeg(configuredPath);
  const stats = await cacheStats(defaultCacheRoot()).catch(() => ({ bytes: 0, files: 0 }));

  if (!tools) {
    reportMissing(ctx);
  } else {
    ctx.health.report({ level: 'ok', message: `ffmpeg 可用：${tools.version}` });
  }

  publishStatus(ctx, {
    ffmpeg: tools ? { text: tools.version.slice(0, 40), tone: 'ok' } : { text: '未找到 ffmpeg', tone: 'error' },
    cache: {
      text: describeCache(stats),
    },
  });
  return tools;
}

/** 只有下载的远程视频、还没抽出帧时也占着磁盘，不能显示「暂无缓存」。 */
function describeCache(stats: { bytes: number; files: number }): string {
  if (stats.files > 0) return `${stats.files} 张 · ${formatBytes(stats.bytes)}`;
  return stats.bytes > 0 ? `视频源 · ${formatBytes(stats.bytes)}` : '暂无缓存';
}

function reportMissing(ctx: PluginContext): void {
  ctx.health.report({
    level: 'warn',
    message: '没有找到 ffmpeg，视频抽帧不可用',
    hint: 'macOS 执行 brew install ffmpeg；已经装了的话，在插件设置里填写 ffmpeg 的绝对路径。',
  });
}

function resolveNumber(raw: unknown, fallback: number): number {
  const value = Number(String(raw ?? '').trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export default function setup(ctx: PluginContext): void {
  plugin.setup(ctx);
}
