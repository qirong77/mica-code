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
