/** Ícones de traço (stroke = currentColor), no mesmo desenho do app antigo e do desktop. */
import type { ReactNode } from 'react'

const PATHS: Record<string, ReactNode> = {
  download: (<><path d="M12 4v10" /><polyline points="7 11 12 16 17 11" /><line x1="5" y1="20" x2="19" y2="20" /></>),
  folder: <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  clock: (<><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" /></>),
  speaker: (<><path d="M4 9v6h3.5L13 19V5L7.5 9z" /><path d="M16.5 8.5a5 5 0 0 1 0 7" /><path d="M19 6a8 8 0 0 1 0 12" /></>),
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  sandbox: (<><path d="M3.5 7.5 12 3l8.5 4.5v9L12 21l-8.5-4.5z" /><path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" /></>),
  plus: (<><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></>),
  x: (<><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></>),
  open: (<><path d="M14 5h5v5" /><line x1="19" y1="5" x2="11" y2="13" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>),
  chevron: <polyline points="9 6 15 12 9 18" />,
  check: <polyline points="5 12.5 10 17 19 7" />,
  trash: (<><line x1="4" y1="7" x2="20" y2="7" /><path d="M9.5 7V4.5h5V7" /><path d="M6.5 7l1 13h9l1-13" /><line x1="10.5" y1="11" x2="10.5" y2="16" /><line x1="13.5" y1="11" x2="13.5" y2="16" /></>),
  reply: (<><polyline points="9 14 4 9 9 4" /><path d="M20 20v-7a4 4 0 0 0-4-4H4" /></>),
  back: (<><line x1="19" y1="12" x2="5" y2="12" /><polyline points="12 19 5 12 12 5" /></>),
  camera: (<><rect x="3" y="7" width="18" height="12" rx="2" /><path d="M8 7l1.5-2h5L16 7" /><circle cx="12" cy="13" r="3" /></>),
  image: (<><rect x="3" y="4.5" width="18" height="15" rx="2" /><circle cx="8.5" cy="9.5" r="1.6" /><path d="M21 16l-5-5L5 19" /></>),
  mic: (<><rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0" /><line x1="12" y1="17.5" x2="12" y2="21" /><line x1="8.5" y1="21" x2="15.5" y2="21" /></>),
  send: (<><line x1="12" y1="19" x2="12" y2="5" /><polyline points="6 11 12 5 18 11" /></>),
  down: (<><line x1="12" y1="5" x2="12" y2="19" /><polyline points="6 13 12 19 18 13" /></>),
  exit: (<><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><polyline points="10 17 15 12 10 7" /><line x1="15" y1="12" x2="3" y2="12" /></>),
  search: (<><circle cx="11" cy="11" r="7" /><line x1="20" y1="20" x2="16.2" y2="16.2" /></>),
  more: (<><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></>),
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  office: (<><path d="M4 20V6l8-3 8 3v14" /><line x1="2.5" y1="20" x2="21.5" y2="20" /><rect x="10" y="14" width="4" height="6" /><line x1="8" y1="9" x2="9.5" y2="9" /><line x1="14.5" y1="9" x2="16" y2="9" /></>),
  plans: (<><rect x="4" y="3.5" width="16" height="17" rx="2" /><line x1="8" y1="8.5" x2="16" y2="8.5" /><line x1="8" y1="12.5" x2="16" y2="12.5" /><line x1="8" y1="16.5" x2="12.5" y2="16.5" /></>),
  board: (<><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="10" rx="1.5" /><rect x="17" y="4" width="4" height="13" rx="1.5" /></>),
  spark: (<><circle cx="12" cy="12" r="3.2" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" /></>),
  gear: (<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>)
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 18, className, strokeWidth = 1.8 }: { name: IconName; size?: number; className?: string; strokeWidth?: number }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}
