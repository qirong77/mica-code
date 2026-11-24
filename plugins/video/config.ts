/**
 * 插件设置 → 运行期配置。
 *
 * 会话进程（`index.ts` 的 setup）与机读接口（`api.ts` 的 handler）读的是同一份
 * `plugin-settings/video.json`，解析规则也必须是同一份：两边各写一遍的话，默认值一变
 * 就会漂移成「接口按 1024 抽、状态页按别的值说」。
 */

const DEFAULT_MAX_EDGE = 1024;
const DEFAULT_CACHE_LIMIT_MB = 512;

export type VideoConfig = {
  ffmpegPath: string | undefined;
  /** 帧的长边像素；调用方给了 scale 时以调用方为准。 */
  maxEdge: number;
  /** 帧与下载源共用的磁盘上限（MB）。 */
  cacheLimitMb: number;
};

export function readVideoConfig(values: Record<string, unknown> | undefined): VideoConfig {
  return {
    ffmpegPath: String(values?.ffmpegPath ?? '').trim() || undefined,
    maxEdge: resolveNumber(values?.maxEdge, DEFAULT_MAX_EDGE),
    cacheLimitMb: resolveNumber(values?.cacheLimitMb, DEFAULT_CACHE_LIMIT_MB),
  };
}

function resolveNumber(raw: unknown, fallback: number): number {
  const value = Number(String(raw ?? '').trim());
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
