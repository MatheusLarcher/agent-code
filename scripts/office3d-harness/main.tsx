/**
 * Monta só o Escritório 3D, em tela cheia, com um chat de mentira. Sem
 * window.api: o 3D começa vazio; Ctrl+Alt+Shift+D liga a demonstração (feed e
 * Quadro falsos). `window.__office` guarda o motor para a validação (câmera,
 * esconder o kanban para medir o "antes") — o motor se anota no 1º requestRender.
 */
import { createRoot } from 'react-dom/client'
import { isCentralConversation } from '@shared/central'
import '@harness-renderer/styles.css'
import { officeStore } from '@harness-renderer/office/officeStore'
import { Office3DEngine } from '@harness-renderer/office3d/engine'
import { Office3DWorkspace } from '@harness-renderer/office3d/Office3DWorkspace'
import { UiProvider } from '@harness-renderer/ui/UiProvider'

const original = Office3DEngine.prototype.requestRender
Office3DEngine.prototype.requestRender = function (this: Office3DEngine): void {
  ;(window as unknown as { __office?: Office3DEngine }).__office = this
  original.call(this)
}

// `?mesmos-agentes`: a demo sem quem a versão anterior não tinha (a Central e as memórias) — medir o "antes" e o "depois" com os mesmos agentes.
if (new URLSearchParams(location.search).has('mesmos-agentes')) {
  const set = officeStore.setOverride.bind(officeStore)
  officeStore.setOverride = (feed) =>
    set(
      feed && {
        ...feed,
        conversations: feed.conversations.filter((c) => !isCentralConversation(c)),
        tracks: Object.fromEntries(Object.entries(feed.tracks).map(([id, t]) => [id, Object.fromEntries(Object.entries(t).filter(([, tr]) => tr.subagentType !== 'memoria'))]))
      }
    )
}

const log = (what: string, id: string): void => console.log(`[harness] ${what}`, id)

// A tela do monitor (CodeMonitor) usa o UiProvider do app.
createRoot(document.getElementById('root') as HTMLElement).render(
  <UiProvider>
    <div style={{ position: 'fixed', inset: 0, display: 'flex' }}>
      <Office3DWorkspace chat={<div style={{ padding: 12, color: '#ccc' }}>chat do harness</div>} onOpenConversation={(id) => log('abrir conversa', id)} />
    </div>
  </UiProvider>
)
