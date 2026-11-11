import type {DOMPurify} from 'dompurify';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FORBIDDEN_TAGS = [
  'script', 'foreignObject', 'iframe', 'object', 'embed', 'image', 'a',
  'animate', 'animateMotion', 'animateTransform', 'set', 'feImage',
];
const FORBIDDEN_NAMES = new Set(FORBIDDEN_TAGS.map(tag => tag.toLowerCase()));
const STYLE_PROPERTIES = new Set([
  'alignment-baseline', 'background', 'background-color', 'baseline-shift',
  'border', 'border-color', 'border-radius', 'border-style', 'border-width',
  'color', 'color-interpolation', 'color-interpolation-filters', 'cursor',
  'display', 'dominant-baseline', 'fill', 'fill-opacity', 'fill-rule',
  'filter', 'flood-color', 'flood-opacity', 'font', 'font-family', 'font-size',
  'font-style', 'font-variant', 'font-weight', 'height', 'letter-spacing',
  'lighting-color', 'line-height', 'marker-end', 'marker-mid', 'marker-start',
  'mask', 'max-height', 'max-width', 'min-height', 'min-width', 'opacity',
  'overflow', 'paint-order', 'pointer-events', 'rx', 'ry', 'shape-rendering',
  'stop-color', 'stop-opacity', 'stroke', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-opacity',
  'stroke-width', 'text-align', 'text-anchor', 'text-decoration',
  'text-decoration-line', 'text-overflow', 'text-rendering', 'text-transform',
  'transform', 'transform-origin', 'unicode-bidi', 'vector-effect', 'vertical-align',
  'visibility', 'white-space', 'width', 'word-break', 'word-spacing',
]);
const PRESENTATION_ATTRIBUTES = new Set([
  'fill', 'stroke', 'filter', 'mask', 'clip-path', 'cursor',
  'marker', 'marker-start', 'marker-mid', 'marker-end',
]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeCSSValue(value: string, allowedIDs: ReadonlySet<string>): boolean {
  // DOMPurify intentionally does not sanitize CSS. Diagrams may contain
  // classDef/style declarations, so reject escapes, imports, external resource
  // references and variable indirection before a stylesheet reaches the page.
  if (/[\\<>@]/.test(value) || /(?:expression|javascript|vbscript|data|var|image-set)\s*[:(]/i.test(value)) return false;
  let validReferences = true;
  const withoutLocalURLs = value.replace(/url\(\s*['"]?#([\w:.-]+)['"]?\s*\)/gi, (_, id: string) => {
    if (!allowedIDs.has(id)) validReferences = false;
    return '';
  });
  return validReferences && !/url\s*\(|(?:https?|file):/i.test(withoutLocalURLs);
}

function sanitizeDeclarations(style: CSSStyleDeclaration, allowedIDs: ReadonlySet<string>): string {
  const result: string[] = [];
  for (let index = 0; index < style.length; index++) {
    const property = style.item(index);
    const value = style.getPropertyValue(property);
    if (STYLE_PROPERTIES.has(property) && safeCSSValue(value, allowedIDs)) {
      result.push(`${property}:${value}${style.getPropertyPriority(property) ? ' !important' : ''}`);
    }
  }
  return result.join(';');
}

function sanitizeStylesheet(css: string, doc: Document, rootID: string, allowedIDs: ReadonlySet<string>): string {
  const Sheet = doc.defaultView?.CSSStyleSheet;
  if (!Sheet) return '';
  const sheet = new Sheet();
  try {
    sheet.replaceSync(css);
  } catch {
    return '';
  }
  const result: string[] = [];
  const prefix = new RegExp(`^#${escapeRegex(rootID)}(?:$|[\\s.:>\\[])`);
  for (const rule of Array.from(sheet.cssRules)) {
    // No imports, font faces, keyframes or nested rules. Every selector must
    // stay within this SVG; sibling combinators could otherwise escape it.
    if (rule.type !== 1) continue;
    const styleRule = rule as CSSStyleRule;
    const selectors = styleRule.selectorText.split(',').map(selector => selector.trim());
    if (!selectors.every(selector => prefix.test(selector) && !/[+~\\]/.test(selector))) continue;
    const declarations = sanitizeDeclarations(styleRule.style, allowedIDs);
    if (declarations) result.push(`${selectors.join(',')}{${declarations}}`);
  }
  return result.join('\n');
}

/**
 * An SVG-only DOMPurify pass, plus CSS/resource isolation and ID namespacing.
 * Never accepts foreignObject/HTML, external images, animation or hyperlinks.
 * Returned markup is the only HTML inserted by the preview component.
 */
export function sanitizeMermaidSVG(markup: string, purifier: DOMPurify, doc: Document, uniqueID: string): string {
  const fragment = purifier.sanitize(markup, {
    USE_PROFILES: {svg: true, svgFilters: true},
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: ['target', 'tabindex'],
    ALLOW_DATA_ATTR: false,
  });
  const svg = fragment.firstElementChild;
  if (!svg || svg.namespaceURI !== SVG_NS || svg.localName !== 'svg') {
    throw new Error('Mermaid did not produce an SVG');
  }
  for (const element of svg.querySelectorAll('*')) {
    const tag = element.localName.toLowerCase();
    if (tag === 'a') element.replaceWith(...element.childNodes);
    else if (element.namespaceURI !== SVG_NS || FORBIDDEN_NAMES.has(tag)) element.remove();
  }
  const originalID = svg.getAttribute('id');
  const ids = new Map<string, string>();
  if (originalID) ids.set(originalID, uniqueID);
  svg.id = uniqueID;
  let idIndex = 0;
  for (const element of svg.querySelectorAll('[id]')) {
    const oldID = element.id;
    const nextID = `${uniqueID}-${++idIndex}`;
    if (!ids.has(oldID)) ids.set(oldID, nextID);
    element.id = nextID;
  }
  const names = [...ids.keys()].sort((left, right) => right.length - left.length);
  const references = names.length ? new RegExp(`#(${names.map(escapeRegex).join('|')})(?=[^\\w:-]|$)`, 'g') : null;
  const rewrite = (text: string) => references ? text.replace(references, (_, id: string) => `#${ids.get(id)}`) : text;
  const allowedIDs = new Set([uniqueID, ...ids.values()]);
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      if (name.startsWith('on') || name === 'src' || name === 'srcset') {
        element.removeAttribute(attribute.name);
      } else if (name === 'href' || name === 'xlink:href') {
        // Only fragment references used by <use> are useful in a static SVG.
        if (/^#[\w:.-]+$/.test(value) && ids.has(value.slice(1))) {
          element.setAttribute(attribute.name, `#${ids.get(value.slice(1))}`);
        } else {
          element.removeAttribute(attribute.name);
        }
      } else if (name === 'aria-labelledby' || name === 'aria-describedby') {
        const references = value.split(/\s+/).map(id => ids.get(id)).filter(Boolean);
        if (references.length) element.setAttribute(attribute.name, references.join(' '));
        else element.removeAttribute(attribute.name);
      } else if (name === 'style') {
        const parsed = doc.createElement('span').style;
        parsed.cssText = rewrite(value);
        const clean = sanitizeDeclarations(parsed, allowedIDs);
        if (clean) element.setAttribute('style', clean);
        else element.removeAttribute('style');
      } else if (PRESENTATION_ATTRIBUTES.has(name) || /url\s*\(/i.test(value)) {
        const rewritten = rewrite(value);
        if (safeCSSValue(rewritten, allowedIDs)) element.setAttribute(attribute.name, rewritten);
        else element.removeAttribute(attribute.name);
      }
    }
    if (element.localName === 'style') {
      element.textContent = sanitizeStylesheet(rewrite(element.textContent || ''), doc, uniqueID, allowedIDs);
    }
  }
  svg.setAttribute('role', 'img');
  if (!svg.hasAttribute('aria-label') && !svg.hasAttribute('aria-labelledby')) {
    svg.setAttribute('aria-label', 'Mermaid 图表');
  }
  // Keep the viewBox/native max-width. CSS scales a diagram down to fit its
  // block without stretching small diagrams to the editor's entire width.
  svg.removeAttribute('height');
  return svg.outerHTML;
}
