import type { ChromeCaller, ChromeTabMemory } from './tools'

// Sem electron/ws: agentSession importa isto, e os testes dele não carregam a ponte.
let bridge: ChromeCaller | null = null
const tabMemory = new Map<string, ChromeTabMemory>()

export function setChromeBridge(next: ChromeCaller | null): void {
  bridge = next
}

export function chromeBridge(): ChromeCaller | null {
  return bridge
}

/** Última aba por conversa; sobrevive aos reinícios da sessão do SDK. */
export function chromeTabMemory(convId: string): ChromeTabMemory {
  let m = tabMemory.get(convId)
  if (!m) tabMemory.set(convId, (m = {}))
  return m
}
