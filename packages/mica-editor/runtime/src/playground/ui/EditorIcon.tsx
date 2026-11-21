import {type ReactNode} from 'react';

import './EditorIcon.css';

const sources = import.meta.glob('../../../../web/assets/yuque/*.svg', {eager: true, query: '?url', import: 'default'});
const assets = Object.fromEntries(Object.entries(sources).map(([path, url]) => [path.split('/').pop()!.replace(/\.svg$/, ''), url as string]));
const aliases: Record<string, string> = {
  bullet: 'bullet-list', number: 'numbered-list', check: 'check-list',
  'toolbar-ellipsis': 'more', highlight: 'bg-color',
};

// Commands without a corresponding public Yuque glyph keep their own symbol.
const paths: Record<string, ReactNode> = {
  'justify-align': <path d="M2 3h12M2 6.5h12M2 10h12M2 13.5h12" />,
  'font-family': <path d="m2 13 4-10 4 10M3.5 9h5M10 6h5m-2.5 0v7" />,
  lowercase: <path d="M2 8c4-3 5 0 5 2v3m0-3c-7-2-7 5 0 2M10 3v10m0-4c5-5 7 5 0 3" />,
  uppercase: <path d="m1 13 4-10 4 10M2.5 9h5M11 3v10h2a2.5 2.5 0 0 0 0-5h-2m0-5h1.5a2.5 2.5 0 0 1 0 5" />,
  capitalize: <path d="m1 13 4-10 4 10M2.5 9h5M11 9c4-3 4 0 4 2v2m0-2c-5-2-5 4 0 1" />,
  ruby: <path d="m3 14 4-8 4 8M4.5 11h5M2 2h3M3.5 2v2M8 2h5m-4 2h3" />,
  'diagram-2': <><path d="M8 5v3M3 10V8h10v2" /><rect x="5.5" y="1.5" width="5" height="3.5" rx=".5" /><rect x="1" y="10" width="4" height="4" rx=".5" /><rect x="11" y="10" width="4" height="4" rx=".5" /></>,
  columns: <><rect x="1.5" y="2.5" width="13" height="11" rx="1" /><path d="M8 2.5v11" /></>,
  component: <><rect x="1.5" y="1.5" width="13" height="13" rx="2.5" /><rect x="5" y="5" width="6" height="6" rx="1" /></>,
};

export default function EditorIcon({icon, className = ''}: {icon: string; className?: string}) {
  const name = aliases[icon] ?? icon;
  const asset = assets[name] ?? (paths[name] ? null : assets.paragraph);
  if (asset) return <span className={`editor-icon format-icon editor-icon--asset ${className}`.trim()}
    data-editor-icon={name} aria-hidden="true" style={{maskImage: `url("${asset}")`}} />;
  return <svg className={`editor-icon format-icon ${className}`.trim()} width="16" height="16" viewBox="0 0 16 16"
    fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {paths[name]}
  </svg>;
}
