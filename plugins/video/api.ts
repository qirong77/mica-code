import {
  PluginApiError,
  pluginApiPath,
  type PluginApiContext,
  type PluginApiEndpoint,
  type PluginApiHandler,
  type PluginApiRequest,
  type PluginApiResponse,
} from '@packages/mica-plugin/index.js';
import { readVideoConfig } from './config.js';
import { extractFrames, FrameExtractionError, isAbortLike, MAX_SCALE, MIN_SCALE } from './extract.js';
import { detectFfmpeg, type FfmpegTools } from './ffmpeg.js';

/**
 * Video 的机读接口：应用现有端口上的 `/plugin/video/api`。
 *
 * 抽帧不再是常驻工具：`video_frames` 的 schema 每轮都随请求发送，而这个能力一个月用
 * 不上几次。改成「文档按需读、接口按需调」之后，会话里零常驻——用户在 `/` 里挑中
 * 这条文档，模型再自己读、自己调。
 *
 * 与工具版本的关键差别：响应里只有本地 JPEG 的路径。接口必须回可 JSON 序列化的值，
 * 图片只能落盘，由模型用内置 `read_image` 逐张看。
 */

const DESCRIPTION = [
  '视频抽帧的机读接口（/plugin/video/api）：按时间点把本地视频抽成 JPEG 帧，返回每帧的本地路径、时间点与视频元信息。',
  '图片不在响应里，也不自动进上下文——拿到 path 之后要用内置 read_image 逐张看。依赖本机 ffmpeg，单次请求 30 秒上限。',
].join('\n');

const GUIDE = [
  '这个接口只做一件事：把视频里的几个时刻抽成本地 JPEG，告诉你路径。图片不会出现在响应里。',
  '',
  '用法（先概览，再点名）：',
  '1. POST /frames {source} 先拿概览：默认 4 帧，顺带拿到时长、分辨率、帧率、有没有音轨。',
  '2. 对返回的每一个 frames[i].path 调内置 read_image（一次 3–6 张），全看完再决定下一步。',
  '3. 要精看某几秒：POST /frames {source, at:["4:50.5","5:10"]} 抽那几个时刻，再 read_image。text 里已经按顺序列好每一行「时间点 + 路径」，直接照它读。',
  '',
  '硬限制（先读这一段，能省掉一次白跑）：',
  '- 单次请求 30 秒上限：宿主到点会中止并返回 504 timeout。本地短视频通常几秒内回；长视频不保证。',
  '- 只适合本地短视频，或已经缓存过的视频。同一个视频的同一批时刻第二次调用直接命中已抽好的帧（不再解码），会快很多；元信息仍要探测一次。',
  '- 远程 http/https 直链虽然支持，但会先把整段视频下载到本机再抽帧：几百 MB 的片子一定超过 30 秒。长视频与远程视频请先把文件下载到本地（浏览器、curl -o、或让用户自己另存），再把本地绝对路径传给 source。',
  '- start / end 只是缩小采样范围，不能突破上面两条：扫描一段 10 分钟的区间仍然要解码那 10 分钟。',
  '',
  '看图纪律：',
  '- 拿到 path 就用 read_image 逐张看，一次 3–6 张。每一帧都会作为图片进入上下文并在后续轮次重复发送，一次看十几张既慢又贵。',
  '- 可寻址单位是时间不是序号：引用某一帧时说 4:50.5，不要说「第 3 帧」——下一轮谁都拿不到这个映射。',
  '- 静止画面（录屏停在一页、单张幻灯片）只会给 1–2 帧，这是刻意的、不是失败；text 的 Notes 会写清楚。',
  '- 音频不会被转写。用户问「说了什么」时先说明这一限制，再看字幕或标注，不要猜音轨内容。',
  '',
  '路径与尺寸：',
  '- source 收本地绝对路径、~/ 开头的路径，或 http/https 直链。相对路径按应用进程的工作目录解析（接口拿不到会话 cwd），所以优先写绝对路径。',
  `- scale（长边像素，${MIN_SCALE}–${MAX_SCALE}）默认取插件设置（1024）。只有要看代码或小字时才调大：每一帧的体积与 token 会成倍上涨。`,
  '- 帧缓存在 $MICA_HOME/plugin-data/video/frames/<视频指纹>/，下载的远程视频在 sources/；两者共用插件设置里的容量上限（默认 512MB），超过时从最旧的开始删。缓存会被淘汰，不保证第二次仍在。',
  '',
  '错误面：400 是参数问题（source 为空、count 不是正整数、时间点写法不对、文件不存在或不是文件），503 是本机没有 ffmpeg，504 是超过 30 秒，500 是解码或写盘失败（message 是能照着改的一句话）。',
].join('\n');

const ENDPOINTS: readonly PluginApiEndpoint[] = [
  {
    method: 'POST',
    path: '/frames',
    summary:
      '按时间点把视频抽成本地 JPEG 帧：返回视频元信息、每帧的绝对路径与时间点；图片本身要用内置 read_image 逐张读。',
    params: [
      {
        name: 'source',
        in: 'body',
        type: 'string',
        required: true,
        description:
          '本地视频路径（绝对路径，或 ~/ 开头；相对路径按应用进程工作目录）或 http/https 直链。远程与长视频先下载到本地再传本地路径。',
      },
      {
        name: 'at',
        in: 'body',
        type: 'string[]',
        description:
          '精确点名的时刻，例如 ["4:50.5", "5:10"]；接受 90（秒）、1:03.5（分:秒）、01:02:03（时:分:秒）。给了它就忽略 count / start / end；最多 8 个，超出按顺序截断。',
      },
      {
        name: 'count',
        in: 'body',
        type: 'number',
        description:
          '不传 at 时抽几帧：默认 4，上限 12。给了非法值（0、负数、非数字）返回 400，不会悄悄按默认值办。给了 at 时 count 不生效。',
      },
      {
        name: 'start',
        in: 'body',
        type: 'string',
        description: '采样区间起点，例如 "2:00"；不传就从开头。只作用于 count 模式（没有 at 时）。',
      },
      {
        name: 'end',
        in: 'body',
        type: 'string',
        description: '采样区间终点，例如 "3:30"；不传就采到结尾。只作用于 count 模式（没有 at 时）。',
      },
      {
        name: 'scale',
        in: 'body',
        type: 'number',
        description: `帧的长边像素，默认取插件设置（1024），可用范围 ${MIN_SCALE}–${MAX_SCALE}，超出会被夹到这个区间。`,
      },
    ],
    returns:
      '{ video:{source,durationSeconds,width,height,fps,hasAudio}, text, frames:[{seconds,at,path,bytes}] }。path 是可直接交给 read_image 的本地绝对路径；at 是格式化后的时间点（引用就用它）；seconds 是同一时刻的秒数；text 是给模型看的同一份摘要（含 Notes、路径列表与取帧说明）。fps 可能为 null。',
    example:
      'curl -s -X POST "$MICA_DESKTOP_ORIGIN/plugin/video/api/frames" -H \'content-type: application/json\' -d \'{"source":"/Users/me/Movies/clip.mov","at":["0:03","0:12"]}\'',
  },
];

export default function createApi(context: PluginApiContext): PluginApiHandler {
  const base = pluginApiPath(context.pluginId);
  // 探测结果按「配置里的路径」缓存：设置改了自动重新探测；没找到时每次都重试，
  // 用户装完 ffmpeg 不必重开应用。
  let tools: FfmpegTools | null = null;
  let resolvedFor: string | undefined;

  async function resolveTools(configuredPath: string | undefined): Promise<FfmpegTools | null> {
    const key = configuredPath?.trim() ?? '';
    if (tools && resolvedFor === key) return tools;
    tools = await detectFfmpeg(configuredPath);
    resolvedFor = key;
    return tools;
  }

  async function frames(request: PluginApiRequest): Promise<PluginApiResponse> {
    const body = bodyRecord(request.body);
    const source = requiredSource(body);
    const config = readVideoConfig(context.settings.get());

    const detected = await resolveTools(config.ffmpegPath);
    if (!detected) {
      throw new PluginApiError(
        503,
        'ffmpeg_missing',
        '没有找到 ffmpeg，视频抽帧接口不可用。请先安装（macOS: brew install ffmpeg），或在配置页 Plugins → Video 里填写 ffmpeg 的绝对路径。',
      );
    }

    const extraction = await extractFrames({
      tools: detected,
      source,
      at: atField(body.at),
      count: body.count,
      start: body.start,
      end: body.end,
      scale: body.scale,
      config,
      signal: request.signal,
    });

    return {
      body: {
        video: {
          source,
          durationSeconds: extraction.probe.durationSeconds,
          width: extraction.probe.width,
          height: extraction.probe.height,
          fps: extraction.probe.fps,
          hasAudio: extraction.probe.hasAudio,
        },
        text: extraction.text,
        frames: extraction.frames,
      },
    };
  }

  return {
    description: DESCRIPTION,
    guide: GUIDE,
    endpoints: ENDPOINTS,
    async handle(request: PluginApiRequest): Promise<PluginApiResponse> {
      throwIfAborted(request);
      try {
        const path = request.path;
        if (path.length === 1 && path[0] === 'frames') {
          if (request.method !== 'POST') {
            throw new PluginApiError(
              405,
              'method_not_allowed',
              `抽帧端点只接受 POST ${base}/frames（JSON 请求体）。不要用 GET 带查询参数。`,
            );
          }
          return await frames(request);
        }
        throw new PluginApiError(
          404,
          'not_found',
          `没有这个端点：${request.method} ${path.length ? `/${path.join('/')}` : '（接口根）'}。GET ${base} 是接口文档，唯一的端点是 POST ${base}/frames。`,
        );
      } catch (error) {
        throw mapError(error, request);
      }
    },
  };
}

/**
 * 稳定错误面：宿主只透出 status / code / message。
 *
 * 取消与超时不改写：宿主靠 signal 判断该回 499 还是 504，这里把它包成 400 会让
 * 「等了 30 秒」看起来像是参数写错了。
 */
function mapError(error: unknown, request: PluginApiRequest): unknown {
  if (error instanceof PluginApiError) return error;
  if (request.signal.aborted) return request.signal.reason ?? error;
  if (isAbortLike(error)) return error;
  if (error instanceof FrameExtractionError) {
    return new PluginApiError(error.code === 'extraction_failed' ? 500 : 400, error.code, error.message);
  }
  return new PluginApiError(500, 'extraction_failed', '抽帧接口内部错误，请稍后重试。');
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginApiError(400, 'invalid_request', '请求体必须是 JSON 对象，例如 {"source":"/abs/clip.mov"}');
  }
  return value as Record<string, unknown>;
}

function requiredSource(body: Record<string, unknown>): string {
  const value = body.source;
  if (typeof value !== 'string' || !value.trim()) {
    throw new PluginApiError(
      400,
      'invalid_request',
      `缺少 source（body.source）：先 POST /frames {"source":"/绝对路径/clip.mov"} 抽 4 帧概览。`,
    );
  }
  return value.trim();
}

/** at 只收字符串或字符串数组：类型错了要当场说清，否则会被 String() 悄悄转成 "[object Object]"。 */
function atField(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return value;
  throw new PluginApiError(
    400,
    'invalid_request',
    'at 必须是时间点字符串数组，例如 ["4:50.5", "5:10"]（也接受单个字符串）。',
  );
}

function throwIfAborted(request: PluginApiRequest): void {
  if (!request.signal.aborted) return;
  throw request.signal.reason ?? new DOMException('Video api request aborted', 'AbortError');
}
