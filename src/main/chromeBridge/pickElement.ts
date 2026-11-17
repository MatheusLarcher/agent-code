// O "Selecionar" do composer: pede à extensão do Chrome que o usuário escolha UM
// elemento na aba em foco e devolve-o no formato que o chat já entende
// (PickedElement → "[elemento N]"). Não depende do toggle "Permitir controle do
// Chrome": quem age é o usuário, com um clique dele; só precisa da extensão conectada.
import type { PickElementResult, PickedElement } from '../../shared/ipc'
import { ERR_NOT_CONNECTED, ERR_PICK_NAVIGATED, ERR_TIMEOUT, PICK_ELEMENT_TIMEOUT_MS } from './protocol'
import type { ChromeCaller } from './tools'

export const PICK_NOT_CONNECTED_MESSAGE = 'Instale ou ative a extensão do Chrome em Configurações'
export const PICK_NAVIGATED_MESSAGE = 'A página mudou durante a seleção. Clique em Selecionar de novo.'
export const PICK_OUTDATED_MESSAGE = 'A extensão do Chrome está desatualizada. Recarregue-a em chrome://extensions e tente de novo.'

const TEXT_MAX = 2000
const HTML_MAX = 4000

const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '')

/** O que a extensão devolveu → PickedElement; resposta sem seletor não é elemento. */
export function toPickedElement(reply: unknown): PickedElement | null {
  const r = (reply ?? {}) as { element?: unknown; tabId?: unknown; title?: unknown; url?: unknown }
  const el = r.element
  if (!el || typeof el !== 'object') return null
  const e = el as Record<string, unknown>
  const selector = str(e.selector, 1000)
  if (!selector) return null
  const pageUrl = str(e.url, 2000) || str(r.url, 2000)
  const title = str(r.title, 200).trim() || pageUrl
  return {
    selector,
    tagName: str(e.tagName, 60),
    id: str(e.id, 300),
    classes: str(e.classes, 1000),
    text: str(e.text, TEXT_MAX),
    html: str(e.html, HTML_MAX),
    url: pageUrl,
    tabId: typeof r.tabId === 'number' ? `chrome:${r.tabId}` : 'chrome',
    tabName: `chrome - ${title}`
  }
}

export interface PickOutcome {
  result: PickElementResult
  /** Só com `result.status === 'picked'`. */
  element: PickedElement | null
}

/** Nunca lança: todo desfecho vira um `PickElementResult` que a tela sabe mostrar. */
export async function pickElementInChrome(bridge: ChromeCaller | null): Promise<PickOutcome> {
  const none = (result: PickElementResult): PickOutcome => ({ result, element: null })
  if (!bridge) return none({ status: 'not-connected', message: PICK_NOT_CONNECTED_MESSAGE })
  try {
    const reply = await bridge.call('pickElement', {}, PICK_ELEMENT_TIMEOUT_MS)
    const element = toPickedElement(reply)
    return element ? { result: { status: 'picked' }, element } : none({ status: 'canceled' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message === ERR_NOT_CONNECTED) return none({ status: 'not-connected', message: PICK_NOT_CONNECTED_MESSAGE })
    if (message.startsWith(ERR_PICK_NAVIGATED)) return none({ status: 'navigated', message: PICK_NAVIGATED_MESSAGE })
    // Dois minutos sem clicar: o usuário desistiu — é um cancelamento, não um erro.
    if (message === ERR_TIMEOUT) return none({ status: 'canceled' })
    if (/Método desconhecido/i.test(message)) return none({ status: 'error', message: PICK_OUTDATED_MESSAGE })
    return none({ status: 'error', message })
  }
}
