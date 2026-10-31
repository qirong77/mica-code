import { docPages } from '../content/docs';
const base = document.querySelector<HTMLElement>('[data-doc-base]')!.dataset.docBase!;
const headings = [...document.querySelectorAll<HTMLElement>('.doc-main h2, .doc-main h3')].filter(
  (heading) => !heading.closest('.card-grid, .guide-grid, .start-grid'),
);
const ids = new Set<string>();
headings.forEach((heading, index) => {
  const original =
    heading.id ||
    heading
      .textContent!.trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '') ||
    `section-${index}`;
  let id = original;
  let suffix = 2;
  while (ids.has(id)) id = `${original}-${suffix++}`;
  ids.add(id);
  heading.id = id;
  const link = document.createElement('a');
  link.href = `#${encodeURIComponent(id)}`;
  link.textContent = heading.textContent;
  link.dataset.heading = id;
  if (heading.tagName === 'H3') link.className = 'toc-child';
  document.getElementById('page-toc')!.append(link);
  document.querySelector('.doc-mobile-toc nav')!.append(link.cloneNode(true));
  const permalink = document.createElement('a');
  permalink.className = 'heading-permalink';
  permalink.href = link.href;
  permalink.textContent = '#';
  permalink.setAttribute('aria-label', `${heading.textContent}：章节链接`);
  heading.append(permalink);
});
document.querySelector('.doc-mobile-toc nav')!.addEventListener('click', (event) => {
  if ((event.target as Element).closest('a')) {
    document.querySelector<HTMLDetailsElement>('.doc-mobile-toc')!.open = false;
  }
});
let scheduled = false;
const updateOutline = () => {
  const current = headings.filter((heading) => heading.getBoundingClientRect().top <= 125).at(-1) || headings[0];
  document.querySelectorAll('#page-toc a').forEach((link) => {
    if ((link as HTMLElement).dataset.heading === current?.id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
  scheduled = false;
};
document.addEventListener(
  'scroll',
  () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(updateOutline);
    }
  },
  { passive: true },
);
updateOutline();
if (location.hash) {
  try {
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  } catch {
    /* Invalid fragment. */
  }
}
const navigation = document.querySelector<HTMLDetailsElement>('.doc-navigation')!;
const desktop = matchMedia('(min-width: 1000px)');
const setNavigation = () => {
  navigation.open = desktop.matches;
};
desktop.addEventListener('change', setNavigation);
setNavigation();
const dialog = document.querySelector<HTMLDialogElement>('.search-dialog')!;
const query = document.querySelector<HTMLInputElement>('#docs-query')!;
const shortcut = document.querySelector('.search-trigger kbd');
if (shortcut && !/Mac|iPhone|iPad/.test(navigator.platform)) shortcut.textContent = 'Ctrl K';
const results = document.querySelector<HTMLElement>('#search-results')!;
const searchStatus = document.querySelector<HTMLElement>('.search-footer')!;
type SearchEntry = { title: string; description: string; text: string; url: string };
const articleText = document.querySelector('.doc-main')?.textContent?.replace(/\s+/g, ' ').trim() || '';
let searchEntries: SearchEntry[] = docPages.map((page) => ({
  ...page,
  text: location.pathname.replace(/\/$/, '').endsWith(`/docs/${page.key}`) ? articleText : '',
  url: `${base}docs/${page.key}/`,
}));
let loading: Promise<void> | undefined;
let indexing = false;
let failedPages = 0;
let selectedIndex = -1;
const updateSelection = (index: number) => {
  const links = [...results.querySelectorAll<HTMLAnchorElement>('a')];
  selectedIndex = index;
  links.forEach((link, position) => link.classList.toggle('search-selected', position === index));
  links[index]?.scrollIntoView({ block: 'nearest' });
};
const render = () => {
  const terms = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const matches = searchEntries.filter((entry) =>
    terms.every((term) => `${entry.title} ${entry.description} ${entry.text}`.toLocaleLowerCase().includes(term)),
  );
  const focused = results.contains(document.activeElement)
    ? (document.activeElement as HTMLAnchorElement).href
    : undefined;
  results.replaceChildren();
  selectedIndex = -1;
  for (const entry of matches) {
    const link = document.createElement('a');
    link.href = entry.url;
    const title = document.createElement('strong');
    title.textContent = entry.title;
    const excerpt = document.createElement('span');
    const matchAt = terms.length ? entry.text.toLocaleLowerCase().indexOf(terms[0]) : -1;
    excerpt.textContent =
      matchAt >= 0 ? `…${entry.text.slice(Math.max(0, matchAt - 24), matchAt + 96)}…` : entry.description;
    link.append(title, excerpt);
    results.append(link);
  }
  if (focused) {
    const links = [...results.querySelectorAll<HTMLAnchorElement>('a')];
    const index = links.findIndex((link) => link.href === focused);
    if (index >= 0) {
      updateSelection(index);
      links[index].focus({ preventScroll: true });
    }
  }
  if (!matches.length) {
    results.textContent = indexing
      ? '正在搜索文档正文…'
      : failedPages
        ? '未在已加载内容中找到结果，请检查网络后重试。'
        : '没有找到相关内容，试试其他关键词。';
  }
  results.setAttribute('aria-busy', String(indexing));
  searchStatus.textContent = indexing
    ? '正在加载正文索引，标题搜索已可用…'
    : failedPages
      ? '部分正文未能加载 · 再次打开搜索可重试'
      : `${matches.length} 篇相关文档 · ↑ ↓ 选择 · Enter 打开`;
};
const loadSearch = () => {
  if (loading) return loading;
  indexing = true;
  failedPages = 0;
  render();
  loading = Promise.all(
    searchEntries.map(async (entry, index) => {
      if (entry.text) return;
      try {
        const response = await fetch(entry.url, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Page unavailable');
        const page = new DOMParser().parseFromString(await response.text(), 'text/html');
        const text = page.querySelector('.doc-main')?.textContent?.replace(/\s+/g, ' ').trim();
        if (!text) throw new Error('Page content unavailable');
        searchEntries[index] = { ...entry, text };
        render();
      } catch {
        failedPages++;
      }
    }),
  ).then(() => {
    indexing = false;
    if (failedPages) loading = undefined;
    render();
  });
  return loading;
};
const open = () => {
  dialog.showModal();
  query.focus();
  render();
  void loadSearch();
};
document.querySelector('.search-trigger')!.addEventListener('click', open);
document.querySelector('.search-close')!.addEventListener('click', () => dialog.close());
dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
});
query.addEventListener('input', render);
dialog.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  const links = [...results.querySelectorAll<HTMLAnchorElement>('a')];
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!links.length) return;
    event.preventDefault();
    const current = links.indexOf(document.activeElement as HTMLAnchorElement);
    const start = current >= 0 ? current : selectedIndex;
    updateSelection(event.key === 'ArrowDown' ? (start + 1) % links.length : (start <= 0 ? links.length : start) - 1);
    links[selectedIndex].focus();
  }
  if (event.key === 'Enter' && event.target === query && links.length) {
    event.preventDefault();
    links[Math.max(0, selectedIndex)].click();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape' && dialog.open) {
    event.preventDefault();
    dialog.close();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (dialog.open) dialog.close();
    else open();
  }
});
