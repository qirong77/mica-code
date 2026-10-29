import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Check, Copy, Smartphone } from 'lucide-react';

/**
 * Mobile 的卡片：手机怎么连上这台机器。
 *
 * 卡片读的是插件自己的 `plugin-data/mobile-relay/data.json`——页面拿不到
 * `plugin-settings`，所以「手机链接是什么、桥在不在、中转机通没通」由插件后端每 15 秒
 * 算好写进去，这里只负责显示。没配置时显示接入步骤，配好了显示链接与状态。
 */

export function summary() {
  return '手机访问';
}

function Dot({ tone }) {
  const color = tone === 'ok' ? 'bg-emerald-400/80' : tone === 'warn' ? 'bg-amber-400/80' : 'bg-white/25';
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />;
}

function Row({ label, value, tone }) {
  return (
    <div className="flex items-center gap-2 px-2.5 py-[5px]">
      <Dot tone={tone} />
      <span className="min-w-0 flex-1 truncate text-[11px] text-white/40">{label}</span>
      <span className="shrink-0 text-[11px] text-white/70">{value}</span>
    </div>
  );
}

/** 「更新于」用相对时间，免得用户对着一个很久以前的快照做判断。 */
function ago(updatedAt) {
  if (!updatedAt) return '尚未上报';
  const seconds = Math.max(0, Math.round((Date.now() - Number(updatedAt)) / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
}

export default function MobileRelayCard({ api }) {
  const [status, setStatus] = useState(null);
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      const result = await api.readData();
      const value = result?.value;
      setStatus(value && typeof value === 'object' ? value : null);
      setError('');
    } catch (caught) {
      setError(caught?.message || String(caught));
    }
  }, [api]);

  // 卡片是浮层，打开期间才轮询；关掉就不占任何资源
  useEffect(() => {
    void reload();
    const timer = setInterval(() => void reload(), 5_000);
    return () => clearInterval(timer);
  }, [reload]);

  const copy = async (text, tag) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(tag);
      setTimeout(() => setCopied(''), 1_500);
    } catch (caught) {
      setError(caught?.message || String(caught));
    }
  };

  const phoneUrl = String(status?.phoneUrl || '');
  const bridgeLabel = status?.bridgePid ? `运行中 · ${status.bridgePid}` : status?.enabled === false ? '已关闭' : '未运行';

  return (
    <>
      <h2 className="mb-1 text-sm font-semibold text-white/95">Mobile</h2>
      <p className="mb-2.5 text-[11px] leading-4 text-white/40">
        手机经中转机打开这台机器上的 Mica，看到的是真实界面。本机只做出站短轮询，不开端口、不转发端口。
      </p>

      {phoneUrl ? (
        <div className="mb-2.5 rounded-sm border border-line bg-white/[.03]">
          <div className="flex items-center gap-2 px-2.5 py-1.5">
            <Smartphone size={14} className="shrink-0 text-white/45" />
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-white/70" title={phoneUrl}>
              {phoneUrl}
            </span>
            <button
              type="button"
              title="复制链接"
              className="shrink-0 text-white/35 hover:text-white"
              onClick={() => void copy(phoneUrl, 'link')}
            >
              {copied === 'link' ? <Check size={13} /> : <Copy size={13} />}
            </button>
            <button
              type="button"
              title="在浏览器打开"
              className="shrink-0 text-white/35 hover:text-white"
              onClick={() => api.open(phoneUrl)}
            >
              <ArrowUpRight size={13} />
            </button>
          </div>
          <div className="border-t border-line">
            <Row label="桥进程" value={bridgeLabel} tone={status?.bridgePid ? 'ok' : 'warn'} />
            <Row
              label="中转机"
              value={status?.relayOnline ? '可达' : '不可达'}
              tone={status?.relayOnline ? 'ok' : 'warn'}
            />
            <Row
              label="手机"
              value={status?.phoneOnline ? '正在看' : '未连接'}
              tone={status?.phoneOnline ? 'ok' : 'idle'}
            />
            <Row label="状态更新" value={ago(status?.updatedAt)} tone="idle" />
          </div>
        </div>
      ) : (
        <div className="mb-2.5 rounded-sm border border-dashed border-white/15 bg-white/[.02] px-2.5 py-2 text-[11px] leading-[1.7] text-white/55">
          <div className="mb-1 text-white/75">还没接上中转机</div>
          <div>在会话里说「帮我配一下手机访问」，agent 会用内置 skill 去做：</div>
          <div>取仓库 → 必要时构建页面产物 → 部署中转机 → 把地址与口令写回这里。</div>
          <div>你也可以自己跑 setup.mjs，见插件目录的 README。</div>
        </div>
      )}

      {error && <p className="mt-2 text-[11px] text-red-400/80">{error}</p>}
    </>
  );
}
