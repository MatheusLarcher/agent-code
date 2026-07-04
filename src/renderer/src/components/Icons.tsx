import type { ReactNode, SVGProps } from 'react'

/**
 * Modern line-icon set (stroke = currentColor), matching the Sidebar/TabIcon style.
 * Every icon inherits the button's color and centers via the existing flex rules.
 */
type IconProps = { size?: number } & SVGProps<SVGSVGElement>

function Svg({ size = 16, children, ...rest }: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconChevronLeft = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <polyline points="15 6 9 12 15 18" />
  </Svg>
)
export const IconChevronRight = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <polyline points="9 6 15 12 9 18" />
  </Svg>
)
/** Collapse the panel toward the right edge. */
export const IconCollapseRight = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <polyline points="13 6 19 12 13 18" />
    <line x1="6" y1="5" x2="6" y2="19" />
  </Svg>
)
export const IconRefresh = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M20 11a8 8 0 0 0-14-4.5L4 8" />
    <polyline points="4 4 4 8 8 8" />
    <path d="M4 13a8 8 0 0 0 14 4.5L20 16" />
    <polyline points="20 20 20 16 16 16" />
  </Svg>
)
export const IconHome = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M4 11l8-7 8 7" />
    <path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" />
  </Svg>
)
export const IconArrowRight = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <line x1="5" y1="12" x2="19" y2="12" />
    <polyline points="13 6 19 12 13 18" />
  </Svg>
)
export const IconArrowUp = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <line x1="12" y1="19" x2="12" y2="5" />
    <polyline points="6 11 12 5 18 11" />
  </Svg>
)
/** A cursor/pointer — "pick an element". */
export const IconPointer = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M5 4l6 16 2.2-6.2L19.5 11z" />
  </Svg>
)
export const IconGlobe = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3c2.6 2.7 3.9 5.8 3.9 9s-1.3 6.3-3.9 9c-2.6-2.7-3.9-5.8-3.9-9S9.4 5.7 12 3z" />
  </Svg>
)
export const IconPlus = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </Svg>
)
export const IconClose = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </Svg>
)
export const IconAt = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.6" />
    <path d="M15.6 12v1.4a2.4 2.4 0 0 0 4.4 1.3A9 9 0 1 0 16 19.5" />
  </Svg>
)
export const IconPaperclip = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
  </Svg>
)
export const IconImage = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2" />
    <circle cx="8.5" cy="9.5" r="1.6" />
    <path d="M21 16l-5-5L5 19" />
  </Svg>
)
export const IconFile = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <polyline points="14 3 14 8 19 8" />
  </Svg>
)
export const IconFolder = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Svg>
)
export const IconBox = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M21 8l-9-5-9 5v8l9 5 9-5z" />
    <path d="M3 8l9 5 9-5" />
    <line x1="12" y1="13" x2="12" y2="21" />
  </Svg>
)
/** Solid square — "stop the running task". */
export const IconStop = ({ size = 14, ...rest }: IconProps): JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...rest}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
)
export const IconSmartphone = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <rect x="7" y="2.5" width="10" height="19" rx="2.6" />
    <line x1="11" y1="18.5" x2="13" y2="18.5" />
  </Svg>
)
export const IconSettings = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </Svg>
)
/** Power symbol — "stop / end the session". */
export const IconPower = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 3v9" />
    <path d="M6.4 6.4a8 8 0 1 0 11.2 0" />
  </Svg>
)
export const IconChevronDown = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <polyline points="6 9 12 15 18 9" />
  </Svg>
)
export const IconMic = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <rect x="9" y="2.5" width="6" height="11" rx="3" />
    <path d="M5.5 11a6.5 6.5 0 0 0 13 0" />
    <line x1="12" y1="17.5" x2="12" y2="21" />
    <line x1="8.5" y1="21" x2="15.5" y2="21" />
  </Svg>
)
/** Speaker with sound waves — "read this aloud". */
export const IconSpeaker = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M4 9v6h3.5L13 19V5L7.5 9z" />
    <path d="M16.5 8.5a5 5 0 0 1 0 7" />
    <path d="M19 6a8 8 0 0 1 0 12" />
  </Svg>
)
/** Filled stop square sized for the small inline message buttons. */
export const IconStopSmall = ({ size = 14, ...rest }: IconProps): JSX.Element => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...rest}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
  </svg>
)
export const IconClock = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 15.5 14" />
  </Svg>
)

export const IconHelp = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9a2.5 2.5 0 0 1 4.9.8c0 1.7-2.4 2-2.4 3.7" />
    <circle cx="12" cy="17" r="0.1" fill="currentColor" stroke="currentColor" strokeWidth="1.5" />
  </Svg>
)

/** Shield-check — used as the shortcut to trigger the code-review skill. */
export const IconShieldCheck = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
    <polyline points="9 12 11 14 15 10" />
  </Svg>
)
