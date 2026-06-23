import type { MouseEvent } from 'react'
import { tabName, type TabInfo } from '@shared/ipc'
import { TabIcon } from './TabIcon'
import { IconClose, IconPlus } from './Icons'

interface Props {
  tabs: TabInfo[]
  /** Open the "new tab" modal (rendered at the app root so it isn't clipped). */
  onRequestNewTab: () => void
}

/** Tab strip for the preview panel: switch / close / open tabs. The LLM sees the
 *  same tabs (by name) and controls whichever one is active. */
export function BrowserTabs({ tabs, onRequestNewTab }: Props): JSX.Element {
  const close = (e: MouseEvent, id: string): void => {
    e.stopPropagation()
    void window.api.closeTab(id)
  }

  return (
    <div className="tab-strip">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.active ? 'active' : ''}`}
          title={tabName(t)}
          onClick={() => !t.active && void window.api.selectTab(t.id)}
        >
          <span className="tab-ico">
            <TabIcon kind={t.kind} />
          </span>
          <span className="tab-name">{tabName(t)}</span>
          <button className="tab-close" title="Fechar aba" onClick={(e) => close(e, t.id)}>
            <IconClose size={13} />
          </button>
        </div>
      ))}

      <button className="tab-new" title="Nova aba" onClick={onRequestNewTab}>
        <IconPlus size={15} />
      </button>
    </div>
  )
}
