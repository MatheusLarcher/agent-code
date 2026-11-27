/**
 * Quais elementos de página estão AGORA no campo de mensagem (na ordem do
 * texto). O Composer publica a cada mudança; o Preview assina para deixar
 * marcado na página só o que ainda está no campo (saiu do campo, ou a mensagem
 * foi enviada → a marca some). Um valor só: o campo da conversa aberta.
 */
import type { PickedElement } from '@shared/ipc'
import type { MarkRef } from '../../../preload/previewInspector/overlay'

export type { MarkRef }

type Listener = (els: readonly PickedElement[]) => void

let current: readonly PickedElement[] = []
const listeners = new Set<Listener>()

export function publishComposerElements(els: readonly PickedElement[]): void {
  const same = els.length === current.length && els.every((e, i) => e === current[i])
  if (same) return
  current = els
  for (const l of listeners) l(current)
}

export function composerElements(): readonly PickedElement[] {
  return current
}

export function subscribeComposerElements(l: Listener): () => void {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/**
 * Os elementos desta aba com o número do "[elemento N]" do campo: a posição na
 * lista INTEIRA (o campo numera todos pela ordem do texto, de qualquer aba),
 * não na lista só desta aba. É o que vai no sync para a marca bater com o chip.
 */
export function marksForTab(els: readonly PickedElement[], tabId: string): MarkRef[] {
  const out: MarkRef[] = []
  els.forEach((e, i) => {
    if (e.tabId === tabId) out.push({ selector: e.selector, n: i + 1 })
  })
  return out
}
