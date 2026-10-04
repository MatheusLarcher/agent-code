/**
 * Ícones do editor do monitor: traço em SVG (nada de emoji), no tamanho do
 * texto. O glifo de arquivo é a "etiqueta" da extensão, na cor que o VS Code
 * costuma dar a ela; o nome da linguagem é o da barra de status.
 */
import type { ReactNode } from 'react'

type IconName =
  | 'files' | 'search' | 'branch' | 'blocks' | 'agent' | 'code' | 'chevron' | 'folder' | 'close' | 'info' | 'follow' | 'check' | 'cross' | 'chat' | 'terminal'
  | 'bot' | 'layers' | 'pin' | 'pin-off' | 'copy' | 'eye' | 'eye-off' | 'lock' | 'history' | 'spark' | 'save' | 'chip' | 'alert' | 'globe'
  | 'users' | 'tree' | 'wand' | 'stamp' | 'user' | 'book' | 'sliders' | 'engine' | 'recv' | 'pencil' | 'file' | 'msg' | 'chevron-down'

const PATHS: Record<IconName, ReactNode> = {
  files: (
    <>
      <path d="M14.5 3H8a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 8 18h9a1.5 1.5 0 0 0 1.5-1.5V7z" />
      <path d="M14.5 3v4h4M4.5 7.5v12A1.5 1.5 0 0 0 6 21h9" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5.5 5.5" />
    </>
  ),
  branch: (
    <>
      <circle cx="6.5" cy="5.5" r="2" />
      <circle cx="6.5" cy="18.5" r="2" />
      <circle cx="17.5" cy="7.5" r="2" />
      <path d="M6.5 7.5v9M17.5 9.5c0 4-5 3-9.6 7.6" />
    </>
  ),
  blocks: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
      <path d="m14.5 3.5 5 5-5 5-5-5z" />
    </>
  ),
  agent: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.8-3.7 3.6-5.5 7-5.5s6.2 1.8 7 5.5" />
    </>
  ),
  code: <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5M13.5 4.5l-3 15" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  folder: <path d="M3.5 7.5V18a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5V9.5A1.5 1.5 0 0 0 19 8h-7.5l-2-2.5H5A1.5 1.5 0 0 0 3.5 7z" />,
  close: <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.6v.1" />
    </>
  ),
  follow: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
      <circle cx="12" cy="12" r="7.5" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  cross: <path d="m7 7 10 10M17 7 7 17" />,
  chat: <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-7l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z" />,
  terminal: <path d="m5 8 4 4-4 4M11 16.5h8" />,
  // Os da barra de tarefas e do app Contexto: os traços do mockup aprovado.
  bot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="3.5" />
      <path d="M12 8V4.5M9 13.5v1.5M15 13.5v1.5M2 13v3M22 13v3" />
      <circle cx="12" cy="3.5" r="1" />
    </>
  ),
  layers: <path d="m12 3 9 4.8-9 4.8-9-4.8zM3 12.2l9 4.8 9-4.8M3 16.6l9 4.8 9-4.8" />,
  pin: <path d="M12 16.5V22M8.5 3h7l-1 5.5 3.5 3.5v2H6v-2l3.5-3.5z" />,
  'pin-off': <path d="M12 16.5V22M8.5 3h7l-1 5.5 3.5 3.5v2H6v-2l3.5-3.5zM3 3l18 18" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2.2" />
      <path d="M5 15V6.2A2.2 2.2 0 0 1 7.2 4H15" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  'eye-off': <path d="M2.5 12S6 5.5 12 5.5c1.6 0 3 .5 4.2 1.1M21.5 12s-1.2 2.3-3.5 4.1A9.4 9.4 0 0 1 12 18.5c-1.6 0-3-.4-4.2-1.1M9.9 9.9a2.8 2.8 0 0 0 4.2 4.2M3 3l18 18" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.2" />
      <path d="M8.5 10.5v-3a3.5 3.5 0 0 1 7 0v3" />
    </>
  ),
  history: <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4v5h5M12 8v4.5l3 1.8" />,
  spark: <path d="M11 3.5c.7 4.6 2.4 6.3 7 7-4.6.7-6.3 2.4-7 7-.7-4.6-2.4-6.3-7-7 4.6-.7 6.3-2.4 7-7zM19 15.5v5M16.5 18h5" />,
  save: <path d="M5 3.5h11l3.5 3.5v12a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5zM8 3.5v5h7.5M8 20.5V14h8v6.5" />,
  chip: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2.5" />
      <path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5M10 12h4" />
    </>
  ),
  alert: <path d="M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0zM12 9.5V14M12 17.2v.1" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.6 2.6 2.6 14.4 0 17M12 3.5c-2.6 2.6-2.6 14.4 0 17" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8.5" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 5a3.5 3.5 0 0 1 0 7M18 14.5a6 6 0 0 1 3.5 5.5" />
    </>
  ),
  tree: (
    <>
      <path d="M4 3.5v13A2.5 2.5 0 0 0 6.5 19H10M4 8.5h6" />
      <rect x="12" y="5.5" width="9" height="6" rx="1.5" />
      <rect x="12" y="15.5" width="9" height="6" rx="1.5" />
    </>
  ),
  wand: <path d="m4 20 11-11M13.5 7.5l3 3M18 2.5v3M16.5 4h3M20.5 8.5v2M19.5 9.5h2M10.5 3v2M9.5 4h2" />,
  stamp: (
    <>
      <rect x="3.5" y="4.5" width="17" height="16" rx="2.5" />
      <path d="M3.5 9.5h17M8 2.5v4M16 2.5v4M12 12.5v3l2 1.3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  book: <path d="M4.5 19.5v-14A2.5 2.5 0 0 1 7 3h12.5v15H7a2.5 2.5 0 0 0 0 5h12.5M9 7.5h6.5" />,
  sliders: (
    <>
      <path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1" />
      <circle cx="15" cy="6.5" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="17.5" r="2" />
    </>
  ),
  engine: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M2.5 12h3M18.5 12h3M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" />
    </>
  ),
  recv: <path d="M12 3.5v11M7 10l5 5 5-5M4.5 20.5h15" />,
  pencil: <path d="M4 20h4.2L19 9.2 14.8 5 4 15.8zM13 6.8l4.2 4.2" />,
  file: <path d="M14 3H7.5A2.5 2.5 0 0 0 5 5.5v13A2.5 2.5 0 0 0 7.5 21h9a2.5 2.5 0 0 0 2.5-2.5V8zM14 3v5h5" />,
  msg: <path d="M20.5 12a8.5 8.5 0 0 1-12.3 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />
}

/** O logo do VS Code (o do título do app Código e da barra de tarefas). */
export function VsCodeLogo({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg className="cm-logo-svg" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path
        fill="#007ACC"
        d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z"
      />
    </svg>
  )
}

/** O ícone do Agent Code (build/icon.svg), o do app Chat. Ids próprios para não colidir no documento. */
export function AgentCodeLogo({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg className="cm-logo-svg" viewBox="0 0 512 512" width={size} height={size} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="cm-ac-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2c2a27" />
          <stop offset="1" stopColor="#1a1918" />
        </linearGradient>
        <radialGradient id="cm-ac-glow" cx="0.5" cy="0.44" r="0.55">
          <stop offset="0" stopColor="#d97757" stopOpacity="0.4" />
          <stop offset="1" stopColor="#d97757" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="cm-ac-spark" x1="0.15" y1="0.1" x2="0.85" y2="0.95">
          <stop offset="0" stopColor="#ef9272" />
          <stop offset="1" stopColor="#c65e3c" />
        </linearGradient>
      </defs>
      <rect x="16" y="16" width="480" height="480" rx="116" fill="url(#cm-ac-bg)" />
      <rect x="16" y="16" width="480" height="480" rx="116" fill="url(#cm-ac-glow)" />
      <path d="M256 86 C 270 196, 316 242, 426 256 C 316 270, 270 316, 256 426 C 242 316, 196 270, 86 256 C 196 242, 242 196, 256 86 Z" fill="url(#cm-ac-spark)" />
      <path d="M390 120 C 395 144, 400 149, 424 154 C 400 159, 395 164, 390 188 C 385 164, 380 159, 356 154 C 380 149, 385 144, 390 120 Z" fill="#f0a484" fillOpacity="0.85" />
    </svg>
  )
}

export type { IconName }

export function Icon({ name, className }: { name: IconName; className?: string }): JSX.Element {
  return (
    <svg className={`cm-icon${className ? ` ${className}` : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  )
}

interface Glyph {
  text: string
  color: string
}

const GLYPHS: Record<string, Glyph> = {
  ts: { text: 'TS', color: '#4d9fe0' },
  mts: { text: 'TS', color: '#4d9fe0' },
  cts: { text: 'TS', color: '#4d9fe0' },
  tsx: { text: 'TSX', color: '#4fc1e9' },
  jsx: { text: 'JSX', color: '#4fc1e9' },
  js: { text: 'JS', color: '#e8d44d' },
  mjs: { text: 'JS', color: '#e8d44d' },
  cjs: { text: 'JS', color: '#e8d44d' },
  json: { text: '{}', color: '#e8d44d' },
  css: { text: '#', color: '#5aa7e8' },
  scss: { text: '#', color: '#e06c9f' },
  less: { text: '#', color: '#5aa7e8' },
  html: { text: '<>', color: '#e37933' },
  htm: { text: '<>', color: '#e37933' },
  xml: { text: '<>', color: '#e37933' },
  vue: { text: 'V', color: '#41b883' },
  svg: { text: 'SVG', color: '#f0a83b' },
  md: { text: 'M↓', color: '#5aa7d9' },
  py: { text: 'PY', color: '#5a9fd4' },
  ipynb: { text: 'NB', color: '#f37626' },
  cs: { text: 'C#', color: '#a97bff' },
  sql: { text: 'SQL', color: '#e0a458' },
  yml: { text: 'YML', color: '#c48bd9' },
  yaml: { text: 'YML', color: '#c48bd9' },
  sh: { text: '$', color: '#89d185' },
  bash: { text: '$', color: '#89d185' },
  ps1: { text: '>_', color: '#5aa7e8' },
  psm1: { text: '>_', color: '#5aa7e8' }
}

export const extOf = (path: string): string => {
  const name = path.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** A etiqueta colorida da extensão (decorativa: o nome do arquivo vem ao lado). */
export function FileGlyph({ path }: { path: string }): JSX.Element {
  const g = GLYPHS[extOf(path)]
  if (!g) return <Icon name="files" className="cm-glyph cm-glyph-plain" />
  return (
    <span className="cm-glyph" style={{ color: g.color }} aria-hidden="true">
      {g.text}
    </span>
  )
}

const LANG_NAMES: Record<string, string> = {
  ts: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', tsx: 'TypeScript JSX',
  js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', jsx: 'JavaScript JSX',
  json: 'JSON', css: 'CSS', scss: 'SCSS', less: 'Less',
  html: 'HTML', htm: 'HTML', xml: 'XML', svg: 'SVG', vue: 'Vue',
  md: 'Markdown', py: 'Python', ipynb: 'Jupyter', cs: 'C#', sql: 'SQL',
  yml: 'YAML', yaml: 'YAML', sh: 'Shell Script', bash: 'Shell Script', ps1: 'PowerShell', psm1: 'PowerShell'
}

/** O nome da linguagem na barra de status. */
export function langName(path: string): string {
  return LANG_NAMES[extOf(path)] ?? 'Texto sem formatação'
}
