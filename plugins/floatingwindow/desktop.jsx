import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Globe, GripVertical, House, Star } from 'lucide-react';
import { ArcoAction, Input } from '@mica-config-ui/web';
import { compactUrl, filterRecent, isRecentUrl, moveHighlight } from '@packages/mica-web-shared/index.js';
import { normalizeAddress, persistableAddress, persistableOrigin } from './address.js';
import './desktop.css';

function check(result) {
  if (result === false || result?.ok === false) throw new Error(result?.error || '操作未完成');
  return result;
}
function message(error) { return error instanceof Error ? error.message : String(error); }

/** 地址栏下拉默认列几条：再多就要滚动了，这里只做「快速回到刚才那个页面」。 */
const SUGGEST_LIMIT = 6;

/**
 * 地址栏下拉要画的行。最近访问在插件数据里是一串完整地址（没有标题），先补成
 * `{ url }` 再交给共用的筛选逻辑——与受控浏览器顶栏是同一套匹配与按键规则。
 */
export function suggestItems(recent, query, limit = SUGGEST_LIMIT) {
  const items = (Array.isArray(recent) ? recent : [])
    .filter((url) => isRecentUrl(url))
    .map((url) => ({ url }));
  return filterRecent(items, query).slice(0, Math.max(0, limit));
}

export function faviconSources(url, faviconUrl) {
  const sources = [];
  if (typeof faviconUrl === 'string' && faviconUrl) sources.push(faviconUrl);
  try { sources.push(`${new URL(url).origin}/favicon.ico`); } catch { /* fallback icon below */ }
  return [...new Set(sources)];
}

/** First candidate the host can materialize wins; failures and misses fall through. */
export async function resolveIcon(sources, loadIcon) {
  if (typeof loadIcon !== 'function') return '';
  for (const candidate of sources) {
    let dataUrl = '';
    try { dataUrl = await loadIcon(candidate); } catch { dataUrl = ''; }
    if (typeof dataUrl === 'string' && dataUrl) return dataUrl;
  }
  return '';
}

/**
 * The launcher page is served under `img-src 'self' data: file:`, so a remote icon
 * URL never draws here: it is fetched and inlined by the host (`web.favicon`) and
 * only the resulting `data:` URL is rendered. Until an icon resolves — and for sites
 * that have none — the generic globe stays, so a missing icon never leaves a hole.
 */
export function SiteIcon({ url, faviconUrl, loadIcon = null }) {
  const sources = faviconSources(url, faviconUrl);
  const [source, setSource] = useState('');
  const key = sources.join('\n');
  useEffect(() => {
    setSource('');
    if (typeof loadIcon !== 'function') return undefined;
    let live = true;
    void (async () => {
      const dataUrl = await resolveIcon(sources, loadIcon);
      if (live && dataUrl) setSource(dataUrl);
    })();
    return () => { live = false; };
    // `key` is the candidate list itself; the array identity changes on every render.
  }, [key, loadIcon]);
  if (!source) return <Globe className="floatingwindow-site-icon" size={16} aria-hidden="true" />;
  return <img className="floatingwindow-site-icon" src={source} alt="" />;
}

/**
 * An address typed on Enter is recorded right away; when the site redirects, the
 * final address must replace that entry instead of sitting next to it. The seed only
 * covers the one navigation it was made for: a page reached by clicking a link later
 * is a visit of its own and must not drop what came before it, so a push carrying the
 * page the open started from — or a navigation that already settled — ends it.
 */
export function seedAfterPush(seed, url, loading) {
  if (!seed || !url) return { replaces: '', seed };
  if (url !== seed.url && url !== seed.from) return { replaces: seed.url, seed: null };
  if (url === seed.url && !loading) return { replaces: '', seed: null };
  return { replaces: '', seed };
}

/** Icons are stored per site: every page of a site shares the icon of its origin. */
export function siteFavicon(favicons, url) {
  const origin = persistableOrigin(url);
  return (origin && favicons && favicons[origin]) || '';
}

/**
 * The icon to store for an address. A push that carries one always wins; otherwise
 * the icon this address announced earlier is used, because a page announces its icon
 * once and later states for the same address may arrive without it (a single-page
 * app navigating within itself, a reload that keeps the icon).
 */
export function iconToRemember(faviconUrl, url, seen) {
  if (typeof faviconUrl === 'string' && faviconUrl) return faviconUrl;
  const known = url && seen && typeof seen.get === 'function' ? seen.get(url) : '';
  return typeof known === 'string' ? known : '';
}

function SiteEntry({ url, favicons, favorite, onOpen, onToggle, loadIcon }) {
  const faviconUrl = siteFavicon(favicons, url);
  return <div className="floatingwindow-site">
    <button type="button" className="floatingwindow-site-open" title={url} onClick={() => onOpen(url)}>
      <SiteIcon url={url} faviconUrl={faviconUrl} loadIcon={loadIcon} />
      <span>{url}</span>
      <ArrowRight size={14} aria-hidden="true" />
    </button>
    <ArcoAction iconOnly className="floatingwindow-site-star" title={favorite ? '取消收藏' : '收藏'} aria-label={favorite ? '取消收藏' : '收藏'} onClick={() => onToggle(url, !favorite)}>
      <Star size={15} fill={favorite ? 'currentColor' : 'none'} />
    </ArcoAction>
  </div>;
}

export function Welcome({ favorites = [], recent = [], favicons = {}, onOpen, onToggle, loadIcon = null }) {
  return <main className="floatingwindow-home">
    <div className="floatingwindow-home-inner">
      <div className="floatingwindow-home-icon" aria-hidden="true"><Globe size={22} /></div>
      <h1>欢迎使用 Floating Window</h1>
      <p>在上方输入网址，或从最近访问的站点快速打开。</p>
      <h2>收藏</h2>
      {favorites.length ? <div className="floatingwindow-sites">{favorites.map((url) => <SiteEntry key={url} url={url} favicons={favicons} favorite onOpen={onOpen} onToggle={onToggle} loadIcon={loadIcon} />)}</div> : <p className="floatingwindow-empty">还没有收藏的站点</p>}
      <h2>最近访问</h2>
      {recent.length ? <div className="floatingwindow-sites">{recent.map((url) => <SiteEntry key={url} url={url} favicons={favicons} favorite={favorites.includes(url)} onOpen={onOpen} onToggle={onToggle} loadIcon={loadIcon} />)}</div> : <p className="floatingwindow-empty">还没有最近访问的站点</p>}
    </div>
  </main>;
}

export function Launcher({ api }) {
  const launcher = api?.launcher;
  const web = launcher?.web;
  const [state, setState] = useState({ url: '', home: true, canGoBack: false, canGoForward: false, loading: false });
  const [address, setAddress] = useState('');
  // 地址栏的最近访问下拉：打开时把网页视图临时让出来（web.cover），页面在它上面画列表
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(-1);
  const [recent, setRecent] = useState([]);
  const [favorites, setFavorites] = useState([]);
  const [favicons, setFavicons] = useState({});
  const [error, setError] = useState('');
  const [saveNotice, setSaveNotice] = useState('');
  const [status, setStatus] = useState(null);
  const available = status?.native !== false && !!web && ['state', 'navigate', 'home', 'back', 'forward', 'subscribe'].every((key) => typeof web[key] === 'function');
  const dirty = useRef(false);
  const latest = useRef('');
  const editVersion = useRef(0);
  const mounted = useRef(false);
  const saveTimer = useRef(null);
  const lastQueued = useRef(null);
  const opened = useRef(null);
  const version = useRef(0);
  const recentVersion = useRef(0);
  const iconCache = useRef(new Map());
  const seenIcons = useRef(new Map());
  // 下拉开着时网页视图要让位（它是原生子视图，永远盖在页面上）。记下此刻是否已经让出，
  // 免得每次重渲染都调一次 `web.cover`，也免得关掉时误把别处让出的视图挂回来。
  const coverHeld = useRef(false);

  /**
   * 下拉里列哪些地址：没在编辑时列全部最近访问（这时输入框显示的是当前页地址，
   * 拿它去筛等于只剩一条），开始输入后按输入筛。
   */
  const suggestions = suggestItems(recent, dirty.current ? address : '');
  const suggestVisible = suggestOpen && suggestions.length > 0;

  /**
   * Load one site's stored collections. Every path that shows the welcome page goes
   * through here — first mount, coming back home, window focus — so a list can never
   * stay stuck at whatever it looked like when the page was first opened.
   */
  const loadSites = useCallback(async () => {
    if (!launcher?.request) return;
    const currentVersion = ++recentVersion.current;
    try {
      const result = check(await launcher.request('recent'));
      if (!mounted.current || currentVersion !== recentVersion.current) return;
      setRecent(Array.isArray(result?.urls) ? result.urls : []);
      setFavorites(Array.isArray(result?.favorites) ? result.favorites : []);
      setFavicons(result?.favicons && typeof result.favicons === 'object' ? result.favicons : {});
      setSaveNotice('');
    } catch (cause) {
      if (mounted.current && currentVersion === recentVersion.current) setSaveNotice(`无法读取最近地址：${message(cause)}`);
    }
  }, [launcher]);

  const closeSuggest = useCallback(() => {
    setSuggestOpen(false);
    setSuggestIndex(-1);
  }, []);

  /**
   * 打开最近访问下拉。列表原来只在欢迎页读过，这里再读一遍：正浏览着网页时点地址栏，
   * 看到的必须是此刻的最近访问，而不是切到网页之前那一份。
   */
  const openSuggest = useCallback(() => {
    if (!available) return;
    setSuggestIndex(-1);
    setSuggestOpen(true);
    void loadSites();
  }, [available, loadSites]);

  /**
   * 让网页视图临时让出 / 回来。让出的只是那块原生视图，页面本身没换：回来时不会重新
   * 加载，滚动位置与登录态都还在（见外壳的 `web.cover`）。
   */
  const setCover = useCallback((next) => {
    if (typeof web?.cover !== 'function') return;
    if (coverHeld.current === next) return;
    coverHeld.current = next;
    void Promise.resolve(web.cover(next)).catch(() => { coverHeld.current = !next; });
  }, [web]);

  useEffect(() => { setCover(suggestVisible); }, [setCover, suggestVisible]);
  useEffect(() => () => { setCover(false); }, [setCover]);

  // 窗口被隐藏（Esc / 快捷键）时页面收不到键盘事件：下拉得自己合上，否则网页回来时
  // 还停在「让位」状态，看起来像页面丢了。
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === 'hidden') closeSuggest(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [closeSuggest]);

  /**
   * Record a site and adopt the list the backend returns. The debounced push path
   * and the explicit "the user asked for this address" path share it, so opening an
   * address never depends on a later state push arriving.
   */
  const rememberSite = useCallback(async (url, faviconUrl = '', replaces = '') => {
    if (!launcher?.request) return;
    try {
      const result = check(await launcher.request('remember', { url, faviconUrl, replaces }));
      if (!mounted.current) return;
      recentVersion.current += 1;
      if (Array.isArray(result?.urls)) setRecent(result.urls);
      if (result?.favicons && typeof result.favicons === 'object') setFavicons(result.favicons);
      setSaveNotice(result?.saved === false ? '无法保存当前站点地址' : '');
    } catch (cause) {
      if (mounted.current) setSaveNotice(`无法保存最近地址：${message(cause)}`);
    }
  }, [launcher]);

  /** Icons reach the page as `data:` URLs; the cache keeps re-renders off the host. */
  const loadIcon = useCallback(async (url) => {
    if (typeof url !== 'string' || !url) return '';
    const cache = iconCache.current;
    if (cache.has(url)) return cache.get(url);
    let dataUrl = '';
    try {
      const result = typeof web?.favicon === 'function' ? await web.favicon(url) : null;
      if (result?.ok === false) dataUrl = '';
      else if (typeof result?.dataUrl === 'string' && result.dataUrl.startsWith('data:image/')) dataUrl = result.dataUrl;
    } catch { dataUrl = ''; }
    if (cache.size >= 200) cache.clear();
    cache.set(url, dataUrl);
    return dataUrl;
  }, [web]);

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
      // The host announces a page's icon once. A later state for the same address may
      // carry none (a single-page app navigating within itself, a reload that keeps
      // the icon), and remembering then would store nothing — so keep the icon seen
      // for this address and use it whenever that address is recorded.
      if (url && faviconUrl) {
        const seen = seenIcons.current;
        if (seen.size >= 50) seen.clear();
        seen.set(url, faviconUrl);
      }
      const decided = seedAfterPush(opened.current, url, !!next.loading);
      opened.current = decided.seed;
      const replaces = decided.replaces;
      if (url && !next.home && (!lastQueued.current || lastQueued.current.url !== url || lastQueued.current.faviconUrl !== faviconUrl)) {
        lastQueued.current = { url, faviconUrl, replaces };
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => {
          if (!live) return;
          void rememberSite(url, iconToRemember(faviconUrl, url, seenIcons.current), replaces);
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
  }, [available, launcher, rememberSite, web]);

  useEffect(() => {
    if (!available || !state.home) return undefined;
    void loadSites();
    // The welcome page can be on screen without a home state push (the native view
    // is hidden either way), so re-read whenever the user comes back to the window.
    const refresh = () => { if (document.visibilityState !== 'hidden') void loadSites(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [available, loadSites, state.home]);

  const run = async (name) => {
    try {
      setError('');
      opened.current = null;
      const startedVersion = editVersion.current;
      check(await web[name]());
      if (name === 'home' && editVersion.current === startedVersion && mounted.current) {
        dirty.current = false;
        setAddress('');
      }
      // Coming home must show the sites visited since the last read, whether or not
      // the host reports the home state (and whatever it reported, an extra read of
      // an in-memory-backed JSON file is cheap).
      if (name === 'home' && mounted.current) void loadSites();
    }
    catch (cause) { if (mounted.current) setError(`操作失败：${message(cause)}`); }
  };
  const open = async (value) => {
    let submittedVersion;
    try {
      closeSuggest();
      const url = normalizeAddress(value);
      submittedVersion = editVersion.current;
      const startedVersion = version.current;
      dirty.current = false;
      setError('');
      check(await web.navigate(url));
      // Remember the address the user asked for right away: the page may redirect,
      // fail or ignore the load, and a missing/slow state push must not cost the
      // visit its place in 最近访问.
      opened.current = { url, from: latest.current };
      // A page opened again already knows its icon from an earlier visit; reusing it
      // keeps the card's icon even when this load never re-announces one.
      const known = iconToRemember('', url, seenIcons.current);
      lastQueued.current = { url, faviconUrl: known, replaces: '' };
      void rememberSite(url, known);
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
        <ArcoAction iconOnly className="floatingwindow-drag" title="拖动窗口" aria-label="拖动窗口"><GripVertical size={15} /></ArcoAction>
        <div className="floatingwindow-address-wrap">
          <Input className="floatingwindow-address" aria-label="网址" aria-expanded={suggestVisible} placeholder="输入域名或网址" autoComplete="off" spellCheck={false} disabled={!available} value={address}
            onFocus={() => openSuggest()}
            onClick={() => openSuggest()}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                if (!suggestions.length) return;
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                if (!suggestOpen) setSuggestOpen(true);
                setSuggestIndex((index) => moveHighlight(suggestOpen ? index : -1, suggestions.length, step));
                return;
              }
              if (event.key !== 'Enter') return;
              event.preventDefault();
              // 输入法组字中的回车是「确认候选词」，不是「打开这个地址」。
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              // 高亮的那一行就是回车要打开的那个地址；没有高亮才走输入框里的内容。
              const picked = suggestVisible && suggestIndex >= 0 ? suggestions[suggestIndex] : null;
              void open(picked ? picked.url : address);
            }}
            onBlur={() => { closeSuggest(); if (!dirty.current) setAddress(latest.current); }}
            onChange={(value) => {
              editVersion.current += 1;
              dirty.current = true;
              setAddress(value);
              setSuggestOpen(true);
              setSuggestIndex(-1);
            }} />
          <ArcoAction iconOnly className="floatingwindow-address-favorite" title={isFavorite ? '取消收藏' : '收藏'} aria-label={isFavorite ? '取消收藏' : '收藏'} disabled={!available || state.home} onClick={() => void toggleFavorite(state.url, !isFavorite)}><Star size={15} fill={isFavorite ? 'currentColor' : 'none'} /></ArcoAction>
          {suggestVisible ? <div className="floatingwindow-suggest" role="listbox" aria-label="最近访问">
            {suggestions.map((item, index) => <button key={item.url} type="button" role="option" aria-selected={index === suggestIndex}
              className={index === suggestIndex ? 'floatingwindow-suggest-item active' : 'floatingwindow-suggest-item'} title={item.url}
              onMouseEnter={() => setSuggestIndex(index)}
              // 按下就取：输入框不失焦，也就不会先触发一次 blur 把列表收掉。
              onMouseDown={(event) => { event.preventDefault(); void open(item.url); }}>
              <SiteIcon url={item.url} faviconUrl={siteFavicon(favicons, item.url)} loadIcon={loadIcon} />
              <span>{compactUrl(item.url)}</span>
              <ArrowRight size={13} aria-hidden="true" />
            </button>)}
          </div> : null}
        </div>
      </form>
      {notice ? <div className="floatingwindow-notice" role={error || state.error ? 'alert' : 'status'} title={notice}>
        <span>{notice}</span>
        {available && shortcutNotice && status?.native !== false ? <ArcoAction onClick={() => void retry()}>重试快捷键</ArcoAction> : null}
      </div> : null}
      {available && state.home ? <Welcome favorites={favorites} recent={recent} favicons={favicons} loadIcon={loadIcon} onOpen={(url) => void open(url)} onToggle={(url, value) => void toggleFavorite(url, value)} /> : null}
    </section>
  );
}
