import { type ReactNode } from 'react';

// A single optical size and stroke weight for editor commands, including More.
const paths: Record<string, ReactNode> = {
  undo: <path d="m5 3-3 3 3 3M2 6h7a4 4 0 0 1 0 8" />,
  redo: <path d="m11 3 3 3-3 3M14 6H7a4 4 0 0 0 0 8" />,
  bold: <path d="M4 2.5h4.5a2.75 2.75 0 0 1 0 5.5H4m0 0h5a2.75 2.75 0 0 1 0 5.5H4v-11" />,
  italic: <path d="M7 2.5h6M3 13.5h6M10 2.5l-4 11" />,
  underline: <path d="M4 2.5v5a4 4 0 0 0 8 0v-5M3 14h10" />,
  strikethrough: (
    <path d="M11.5 4.5c-.5-3-7-3-7 0 0 1.5 1.5 2 3.5 2.5M2 8h12M4.5 11c.5 3 7 3 7 0 0-1.5-1.5-2-3.5-2.5" />
  ),
  code: <path d="m5 4-4 4 4 4m6-8 4 4-4 4M9.5 2.5l-3 11" />,
  clear: <path d="m9.5 2.5 4 4a1 1 0 0 1 0 1.4L7.4 14H4.5l-2-2a1 1 0 0 1 0-1.4l7-8.1ZM6 6.5l5 5M7 14h7" />,
  link: (
    <path d="m6 10 4-4M5.5 11.5l-1 1a2.8 2.8 0 0 1-4-4l3-3a2.8 2.8 0 0 1 4 0m1-1 1-1a2.8 2.8 0 0 1 4 4l-3 3a2.8 2.8 0 0 1-4 0" />
  ),
  quote: <path d="M2.5 3.5h4v5h-4v-5Zm0 5c0 2 1 3 3 3m4-8h4v5h-4v-5Zm0 5c0 2 1 3 3 3" />,
  'horizontal-rule': <path d="M2 8h12" />,
  'bullet-list': (
    <>
      <path d="M6 3h8M6 8h8M6 13h8" />
      <path d="M2 3h.1M2 8h.1M2 13h.1" strokeWidth="2.5" />
    </>
  ),
  'numbered-list': <path d="M6 3h8M6 8h8M6 13h8M1 2h1v3M1 8c0-1.5 2-1.5 2 0 0 .5-2 2-2 2h2M1 12h1a1 1 0 0 1 0 2H1" />,
  'check-list': (
    <>
      <rect x="1.5" y="2.5" width="5" height="5" rx="1" />
      <path d="m3 5 1 1 2-2M9 5h5M2 11h4M9 11h5" />
    </>
  ),
  indent: <path d="M2 2.5h12M8 6h6M8 10h6M2 13.5h12m-12-8 3 2.5-3 2.5" />,
  outdent: <path d="M2 2.5h12M8 6h6M8 10h6M2 13.5h12m-9-8L2 8l3 2.5" />,
  'left-align': <path d="M2 3h12M2 6.5h8M2 10h12M2 13.5h8" />,
  'center-align': <path d="M2 3h12M4 6.5h8M2 10h12M4 13.5h8" />,
  'right-align': <path d="M2 3h12M6 6.5h8M2 10h12M6 13.5h8" />,
  'justify-align': <path d="M2 3h12M2 6.5h12M2 10h12M2 13.5h12" />,
  paragraph: <path d="M8 2v12M12 2v12M14 2H5a3 3 0 0 0 0 6h3" />,
  'font-family': <path d="m2 13 4-10 4 10M3.5 9h5M10 6h5m-2.5 0v7" />,
  'font-color': <path d="m4 10 4-8 4 8M5.5 7h5M2 14h12" />,
  'bg-color': <path d="m5 10 6-7 3 3-6 7H4v-3Zm4-5 3 3M2 14h12" />,
  highlight: <path d="m5 10 6-7 3 3-6 7H4v-3Zm4-5 3 3M2 14h12" />,
  subscript: <path d="m2 3 7 8m0-8-7 8m10 0c0-2 3-2 3 0 0 1-3 3-3 3h3" />,
  superscript: <path d="m2 5 7 8m0-8-7 8m10-10c0-2 3-2 3 0 0 1-3 3-3 3h3" />,
  lowercase: <path d="M2 8c4-3 5 0 5 2v3m0-3c-7-2-7 5 0 2M10 3v10m0-4c5-5 7 5 0 3" />,
  uppercase: <path d="m1 13 4-10 4 10M2.5 9h5M11 3v10h2a2.5 2.5 0 0 0 0-5h-2m0-5h1.5a2.5 2.5 0 0 1 0 5" />,
  capitalize: <path d="m1 13 4-10 4 10M2.5 9h5M11 9c4-3 4 0 4 2v2m0-2c-5-2-5 4 0 1" />,
  ruby: <path d="m3 14 4-8 4 8M4.5 11h5M2 2h3M3.5 2v2M8 2h5m-4 2h3" />,
  plus: <path d="M8 2v12M2 8h12" />,
  table: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M1.5 6h13M6 6v7.5M10 6v7.5M1.5 10h13" />
    </>
  ),
  image: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <circle cx="5" cy="6" r="1" />
      <path d="m2 12 4-4 3 3 2-2 3 3" />
    </>
  ),
  'diagram-2': (
    <>
      <path d="M8 5v3M3 10V8h10v2" />
      <rect x="5.5" y="1.5" width="5" height="3.5" rx=".5" />
      <rect x="1" y="10" width="4" height="4" rx=".5" />
      <rect x="11" y="10" width="4" height="4" rx=".5" />
    </>
  ),
  columns: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1" />
      <path d="M8 2.5v11" />
    </>
  ),
  equation: <path d="M13 3H3l5 5-5 5h10" />,
  'caret-right': <path d="m6 3 5 5-5 5" />,
  calendar: (
    <>
      <rect x="2" y="3.5" width="12" height="11" rx="1" />
      <path d="M5 1.5v4M11 1.5v4M2 7h12M5 10h1M10 10h1" />
    </>
  ),
  'toolbar-ellipsis': <path d="M3 8h.1M8 8h.1M13 8h.1" strokeWidth="2.5" />,
};

export default function EditorIcon({ icon, className = '' }: { icon: string; className?: string }) {
  const heading = /^h([1-6])$/.exec(icon);
  const aliases: Record<string, string> = {
    bullet: 'bullet-list',
    number: 'numbered-list',
    check: 'check-list',
  };
  return (
    <svg
      className={`editor-icon format-icon ${className}`.trim()}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {heading ? (
        <>
          <path d="M2 3v10M9 3v10M2 8h7" />
          <text x="11" y="13" fill="currentColor" stroke="none" fontSize="8" fontFamily="Arial, sans-serif">
            {heading[1]}
          </text>
        </>
      ) : (
        (paths[aliases[icon] ?? icon] ?? paths.paragraph)
      )}
    </svg>
  );
}
