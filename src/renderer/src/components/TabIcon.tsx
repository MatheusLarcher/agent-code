import type { TabKind } from '@shared/ipc'

/** Modern line icons (currentColor) for each preview kind. */
export function TabIcon({ kind, size = 15 }: { kind: TabKind; size?: number }): JSX.Element {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const
  }
  if (kind === 'android') {
    return (
      <svg {...common}>
        <path d="M4 14a8 8 0 0 1 16 0z" />
        <line x1="7" y1="5.5" x2="9" y2="8.5" />
        <line x1="17" y1="5.5" x2="15" y2="8.5" />
        <circle cx="9.5" cy="11" r="0.8" fill="currentColor" stroke="none" />
        <circle cx="14.5" cy="11" r="0.8" fill="currentColor" stroke="none" />
      </svg>
    )
  }
  if (kind === 'iphone') {
    return (
      <svg {...common}>
        <rect x="7" y="2.5" width="10" height="19" rx="2.6" />
        <line x1="10.5" y1="5" x2="13.5" y2="5" />
        <line x1="11" y1="19" x2="13" y2="19" />
      </svg>
    )
  }
  if (kind === 'file') {
    // Arquivo — a little folder.
    return (
      <svg {...common}>
        <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
    )
  }
  // web — a crisp globe
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.6 2.7 3.9 5.8 3.9 9s-1.3 6.3-3.9 9c-2.6-2.7-3.9-5.8-3.9-9S9.4 5.7 12 3z" />
    </svg>
  )
}
