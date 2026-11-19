import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Globe, House, RotateCw, Star, X } from 'lucide-react';
import { ArcoAction, Input } from '@mica-config-ui/web';
import { normalizeAddress, persistableAddress } from './address.js';
import './desktop.css';

function check(result) {
  if (result === false || result?.ok === false) throw new Error(result?.error || '操作未完成');
  return result;
}
function message(error) { return error instanceof Error ? error.message : String(error); }

function faviconSources(url, faviconUrl) {
  const sources = [];
  if (typeof faviconUrl === 'string' && faviconUrl) sources.push(faviconUrl);
  try { sources.push(`${new URL(url).origin}/favicon.ico`); } catch { /* fallback icon below */ }
  return [...new Set(sources)];
}

export function SiteIcon({ url, faviconUrl }) {
  const sources = faviconSources(url, faviconUrl);
  const [sourceIndex, setSourceIndex] = useState(0);
  useEffect(() => setSourceIndex(0), [sources.join('\n')]);
  const source = sources[sourceIndex];
  if (!source) return <Globe className="floatingwindow-site-icon" size={16} aria-hidden="true" />;
  return <img className="floatingwindow-site-icon" src={source} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setSourceIndex((index) => index + 1)} />;
}

function SiteEntry({ url, faviconUrl, favorite, onOpen, onToggle }) {
  return <div className="floatingwindow-site">
    <button type="button" className="floatingwindow-site-open" title={url} onClick={() => onOpen(url)}>
      <SiteIcon url={url} faviconUrl={faviconUrl} />
      <span>{url}</span>
      <ArrowRight size={14} aria-hidden="true" />
    </button>
    <ArcoAction iconOnly className="floatingwindow-site-star" title={favorite ? '取消收藏' : '收藏'} aria-label={favorite ? '取消收藏' : '收藏'} onClick={() => onToggle(url, !favorite)}>
      <Star size={15} fill={favorite ? 'currentColor' : 'none'} />
    </ArcoAction>
  </div>;
}

export function Welcome({ favorites = [], recent = [], favicons = {}, onOpen, onToggle }) {
  return <main className="floatingwindow-home">
    <div className="floatingwindow-home-inner">
      <div className="floatingwindow-home-icon" aria-hidden="true"><Globe size={22} /></div>
      <h1>欢迎使用 Floating Window</h1>
      <p>在上方输入网址，或从最近访问的站点快速打开。</p>
      <h2>收藏</h2>
      {favorites.length ? <div className="floatingwindow-sites">{favorites.map((url) => <SiteEntry key={url} url={url} faviconUrl={favicons[url]} favorite onOpen={onOpen} onToggle={onToggle} />)}</div> : <p className="floatingwindow-empty">还没有收藏的站点</p>}
      <h2>最近访问</h2>
      {recent.length ? <div className="floatingwindow-sites">{recent.map((url) => <SiteEntry key={url} url={url} faviconUrl={favicons[url]} favorite={favorites.includes(url)} onOpen={onOpen} onToggle={onToggle} />)}</div> : <p className="floatingwindow-empty">还没有最近访问的站点</p>}
    </div>
  </main>;
}

export function Launcher({ api, onClose }) {
  const launcher = api?.launcher;
  const web = launcher?.web;
  const [state, setState] = useState({ url: '', home: true, canGoBack: false, canGoForward: false, loading: false });
  const [address, setAddress] = useState('');
  const [recent, setRecent] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [favicons, setFavicons] = useState({});
  const [error, setError] = useState('');
  const [saveNotice, setSaveNotice] = useState('');
  const [status, setStatus] = useState(null);
  const available = status?.native !== false && !!web && ['state', 'navigate', 'home', 'back', 'forward', 'reload', 'subscribe'].every((key) => typeof web[key] === 'function');
  const dirty = useRef(false);
  const latest = useRef('');
  const editVersion = useRef(0);
  const mounted = useRef(false);
  const saveTimer = useRef(null);
  const lastQueued = useRef(null);
  const version = useRef(0);
  const recentVersion = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const readStatus = async () => {
      if (!launcher?.status) return;
      try { const value = check(await launcher.status()); if (mounted.current) setStatus(value); }
      catch (cause) { if (mounted.current) setStatus({ native: true, registered: false, error: message(cause) }); }
    };
    void readStatus();
    window.addEventListener('focus', readStatus);
    return () => { mounted.current = false; window.removeEventListener('focus', readStatus); };
  }, [launcher]);

  useEffect(() => {
    if (!available) return undefined;
    let live = true;
    const apply = (next) => {
      if (!live || !next || typeof next !== 'object') return;
      check(next);
      version.current += 1;
      const url = typeof next.url === 'string' && next.url !== 'about:blank' ? next.url : '';
      latest.current = url;
      setState(next);
      if (!dirty.current) setAddress(url);
      if (!url) lastQueued.current = null;
      const faviconUrl = typeof next.faviconUrl === 'string' ? next.faviconUrl : '';
      if (url && !next.home && (!lastQueued.current || lastQueued.current.url !== url || lastQueued.current.faviconUrl !== faviconUrl)) {
        lastQueued.current = { url, faviconUrl };
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(async () => {
          try {
            const result = check(await launcher.request('remember', { url, faviconUrl }));
            if (live) {
              recentVersion.current += 1;
              if (Array.isArray(result?.urls)) setRecent(result.urls);
              if (result?.favicons && typeof result.favicons === 'object') setFavicons(result.favicons);
              setSaveNotice(result?.saved === false ? '无法保存当前站点地址' : '');
            }
          } catch (cause) {
            if (live) { lastQueued.current = null; setSaveNotice(`无法保存最近地址：${message(cause)}`); }
          }
        }, 400);
      }
    };
    let unsubscribe;
    try { unsubscribe = web.subscribe((next) => { try { apply(next); } catch (cause) { if (live) setError(message(cause)); } }); }
    catch (cause) { setError(`无法订阅网页状态：${message(cause)}`); }
    const startVersion = version.current;
    void (async () => {
      try {
        const current = check(await web.state());
        if (!live) return;
        if (version.current === startVersion) apply(current);
      } catch (cause) { if (live) setError(`无法读取网页状态：${message(cause)}`); }
    })();
    return () => {
      live = false;
      clearTimeout(saveTimer.current);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [available, launcher, web]);

  useEffect(() => {
    if (!available || !state.home) return undefined;
    let live = true;
    const currentVersion = ++recentVersion.current;
    void (async () => {
      try {
        const result = check(await launcher.request('recent'));
        if (live && currentVersion === recentVersion.current) {
          setRecent(Array.isArray(result?.urls) ? result.urls : []);
          setFavorites(Array.isArray(result?.favorites) ? result.favorites : []);
          setFavicons(result?.favicons && typeof result.favicons === 'object' ? result.favicons : {});
          setSaveNotice('');
        }
      } catch (cause) { if (live && currentVersion === recentVersion.current) setSaveNotice(`无法读取最近地址：${message(cause)}`); }
    })();
    return () => { live = false; };
  }, [available, launcher, state.home]);

  const run = async (name) => {
    try {
      setError('');
      const startedVersion = editVersion.current;
      check(await web[name]());
      if (name === 'home' && editVersion.current === startedVersion && mounted.current) {
        dirty.current = false;
        setAddress('');
      }
    }
    catch (cause) { if (mounted.current) setError(`操作失败：${message(cause)}`); }
  };
  const open = async (value) => {
    let submittedVersion;
    try {
      const url = normalizeAddress(value);
      submittedVersion = editVersion.current;
      const startedVersion = version.current;
      dirty.current = false;
      setError('');
      check(await web.navigate(url));
      if (editVersion.current === submittedVersion) {
        if (mounted.current && version.current === startedVersion) setAddress(url);
      }
    } catch (cause) {
      if (submittedVersion !== undefined && editVersion.current === submittedVersion) dirty.current = true;
      if (mounted.current) setError(`无法打开：${message(cause)}`);
    }
  };
  const toggleFavorite = async (value, nextFavorite) => {
    try {
      setError('');
      const result = check(await launcher.request('favorite', { url: value, favorite: nextFavorite }));
      if (Array.isArray(result?.favorites)) setFavorites(result.favorites);
    } catch (cause) { if (mounted.current) setError(`无法保存收藏：${message(cause)}`); }
  };
  const navigate = (event) => { event.preventDefault(); void open(address); };
  const retry = async () => {
    try { check(await launcher.retry()); setStatus(check(await launcher.status())); }
    catch (cause) { setError(`快捷键重试失败：${message(cause)}`); }
  };
  const close = async () => {
    try { if (launcher?.close) check(await launcher.close()); else onClose?.(); }
    catch (cause) { setError(`无法关闭：${message(cause)}`); }
  };
  const shortcutNotice = status?.native === false ? '当前环境不支持系统快捷键' : status && !status.registered ? `快捷键注册失败${status.error ? `：${status.error}` : '，可能已被其他应用占用'}` : '';
  const notice = !available ? '当前环境不支持原生网页浮窗，请在 Mica 桌面端打开' : [error || state.error, shortcutNotice, saveNotice].filter(Boolean).join(' · ') || (state.loading ? '正在加载…' : '');
  const currentSite = state.home ? '' : persistableAddress(state.url) || '';
  const isFavorite = !!currentSite && favorites.includes(currentSite);
  return (
    <section className="mica-config-ui floatingwindow" aria-label="浏览器浮窗">
      <form className="floatingwindow-toolbar" onSubmit={navigate}>
        <ArcoAction iconOnly title="后退" aria-label="后退" disabled={!available || state.home || !state.canGoBack} onClick={() => void run('back')}><ArrowLeft size={15} /></ArcoAction>
        <ArcoAction iconOnly title="前进" aria-label="前进" disabled={!available || state.home || !state.canGoForward} onClick={() => void run('forward')}><ArrowRight size={15} /></ArcoAction>
        <ArcoAction iconOnly title="欢迎页" aria-label="欢迎页" disabled={!available || state.home} onClick={() => void run('home')}><House size={15} /></ArcoAction>
        <ArcoAction iconOnly title="刷新" aria-label="刷新" disabled={!available || state.home} onClick={() => void run('reload')}><RotateCw size={15} /></ArcoAction>
        <ArcoAction iconOnly title={isFavorite ? '取消收藏' : '收藏'} aria-label={isFavorite ? '取消收藏' : '收藏'} disabled={!available || state.home} onClick={() => void toggleFavorite(state.url, !isFavorite)}><Star size={15} fill={isFavorite ? 'currentColor' : 'none'} /></ArcoAction>
        <Input className="floatingwindow-address" aria-label="网址" placeholder="输入域名或网址" autoComplete="off" spellCheck={false} disabled={!available} value={address}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (!event.nativeEvent.isComposing && event.keyCode !== 229) void open(address);
          }}
          onBlur={() => { if (!dirty.current) setAddress(latest.current); }}
          onChange={(value) => { editVersion.current += 1; dirty.current = true; setAddress(value); }} />
        <ArcoAction iconOnly title="关闭" aria-label="关闭" onClick={() => void close()}><X size={15} /></ArcoAction>
      </form>
      {notice ? <div className="floatingwindow-notice" role={error || state.error ? 'alert' : 'status'} title={notice}>
        <span>{notice}</span>
        {available && shortcutNotice && status?.native !== false ? <ArcoAction onClick={() => void retry()}>重试快捷键</ArcoAction> : null}
      </div> : null}
      {available && state.home ? <Welcome favorites={favorites} recent={recent} favicons={favicons} onOpen={(url) => void open(url)} onToggle={(url, value) => void toggleFavorite(url, value)} /> : null}
    </section>
  );
}
