/** Envolve uma mensagem com o gesto de responder (arrastar para a direita), na Central e no chat normal. */
import type { CSSProperties, ReactNode } from 'react'
import { Icon } from '../ui/icons'
import type { CentralQuote } from './centralStore'
import { useSwipeReply } from './useSwipeReply'

export function Swipeable({ quote, className, style, children, ...rest }: {
  quote: CentralQuote | null
  className: string
  style?: CSSProperties
  children: ReactNode
  'data-mid'?: string
}): JSX.Element {
  const swipe = useSwipeReply(quote)
  if (!swipe) return <div className={className} style={style} {...rest}>{children}</div>
  return (
    <div className={`${className} ${swipe.className}`} style={{ ...style, ...swipe.style }} {...rest} {...swipe.handlers}>
      {children}
      <span className={`c-swipe-ic${swipe.armed ? ' armed' : ''}`} style={{ opacity: swipe.iconOpacity }}>
        <Icon name="reply" size={16} />
      </span>
    </div>
  )
}
