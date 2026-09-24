// render_check.js -- execute the dashboard page's JS against a live /api/data
// payload using a minimal DOM shim, so a rendering regression fails loudly
// instead of only showing up in a browser.  No dependencies (Node stdlib only).
//
//   python3 dashboard.py &            # serves on 127.0.0.1:8790
//   node render_check.js              # fetches /api/data and renders it
//   node render_check.js payload.json # or render a saved payload
//
// It extracts the page + <script> straight out of dashboard.py, so there is no
// second copy of the markup to keep in sync.

const fs = require('fs');
const path = require('path');
const http = require('http');

const HERE = __dirname;
const PORT = process.env.PORT || 8790;

function extractPage() {
  const src = fs.readFileSync(path.join(HERE, 'dashboard.py'), 'utf8');
  const start = src.indexOf('PAGE = r"""');
  if (start < 0) throw new Error('PAGE = r""" not found in dashboard.py');
  const rest = src.slice(start + 'PAGE = r"""'.length);
  const end = rest.indexOf('"""');
  if (end < 0) throw new Error('closing triple quote for PAGE not found');
  const page = rest.slice(0, end);
  const m = page.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('<script> block not found in the page');
  return { page, js: m[1] };
}

function makeEl(tag) {
  return {
    tagName: tag,
    children: [],
    _text: '',
    className: '',
    style: {},
    listeners: {},
    get firstChild() { return this.children[0] || null; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() {
      if (this.children.length) return this.children.map(c => c.textContent).join('');
      return this._text;
    },
  };
}

function fetchPayload(file) {
  if (file) return Promise.resolve(JSON.parse(fs.readFileSync(file, 'utf8')));
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/api/data' }, res => {
      let buf = '';
      res.on('data', d => (buf += d));
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad JSON from /api/data: ' + e.message)); }
      });
    }).on('error', reject);
  });
}

const { page, js } = extractPage();
const registry = new Map();
globalThis.document = {
  createElement: makeEl,
  createTextNode: t => ({ textContent: String(t), children: [] }),
  getElementById: id => {
    if (!registry.has(id)) registry.set(id, makeEl('div'));
    return registry.get(id);
  },
};
globalThis.setInterval = () => 0;

const arg = process.argv[2];

// structural sanity on the markup before running anything
const declared = new Set([...page.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const used = new Set([...js.matchAll(/getElementById\("([^"]+)"\)/g)].map(m => m[1]));
const problems = [];
for (const id of used) if (!declared.has(id)) problems.push('JS uses #' + id + ' but the HTML has no such id');

fetchPayload(arg).then(payload => {
  globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
  let syncThrow = null;
  try { eval(js); } catch (e) { syncThrow = e; }
  if (syncThrow) {
    console.error('SYNC THROW while loading the page script:\n', syncThrow.stack || syncThrow);
    process.exit(1);
  }

  setTimeout(() => {
    const countRows = id => {
      let n = 0;
      (function rec(el) {
        if (el.tagName === 'tr') n++;
        (el.children || []).forEach(rec);
      })(document.getElementById(id));
      return n;
    };
    const p = payload.progress;
    const rows = {
      matrix: countRows('matrix-wrap'),
      live: countRows('live-wrap'),
      totals: countRows('totals-wrap'),
      cells: countRows('cells-wrap'),
      errors: countRows('errors-wrap'),
    };
    const want = {
      matrix: 1 + payload.agents.length,
      live: payload.live.length ? 1 + payload.live.length : 0,
      totals: 1 + payload.agents.length,
      cells: 1 + payload.matrix.length,
      errors: 1 + payload.agents.length + (payload.errors.recent.length ? 1 + payload.errors.recent.length : 0),
    };
    for (const k of Object.keys(want)) {
      if (rows[k] !== want[k]) problems.push(`${k}: rendered ${rows[k]} <tr>, expected ${want[k]}`);
    }
    for (const [id, needle] of [
      ['tag', payload.tag],
      ['stamp', 'updated ' + payload.generated_at_local],
      ['pills', p.done + '/' + p.total + ' done'],
      ['errors-note', payload.errors.total + ' HTTP >= 400'],
    ]) {
      const txt = document.getElementById(id).textContent;
      if (txt.indexOf(needle) === -1) problems.push(`#${id} should contain "${needle}", got "${txt.slice(0, 140)}"`);
    }
    // every cell must actually carry text (catches a renderer that bails out)
    const cellRows = countRows('cells-wrap');
    if (cellRows < 2) problems.push('per-cell table rendered no data rows');
    const bodyText = ['cards', 'matrix-wrap', 'live-wrap', 'totals-wrap', 'cells-wrap', 'errors-wrap', 'sources-wrap']
      .map(id => document.getElementById(id).textContent).join(' ');
    if (bodyText.length < 400) problems.push('rendered text suspiciously short: ' + bodyText.length + ' chars');
    const summed = p.done + p.running + p.stalled + p.pending + (p.live_with_verdict || 0);
    if (summed !== p.total) problems.push(`progress accounting does not sum to the matrix: ${summed} != ${p.total}`);

    console.log('rendered <tr> counts :', JSON.stringify(rows));
    console.log('expected             :', JSON.stringify(want));
    console.log('rendered text chars  :', bodyText.length);
    console.log('progress invariant   :', summed + ' / ' + p.total);
    if (problems.length) {
      console.error('FAIL:\n - ' + problems.join('\n - '));
      process.exit(1);
    }
    console.log('RENDER OK');
  }, 50);
}).catch(e => {
  console.error('could not load payload:', e.message);
  process.exit(2);
});
