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
    <path d="M19.4 12a7.5 7.5 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7.3 7.3 0 0 0-2-1.2L16.5 3h-4l-.5 2.4a7.3 7.3 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7.5 7.5 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9c.6.5 1.3.9 2 1.2l.5 2.4h4l.5-2.4c.7-.3 1.4-.7 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" />
  </Svg>
)
export const IconClock = (p: IconProps): JSX.Element => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 15.5 14" />
  </Svg>
)
