import type { HandoffNotice, HandoffNoticeTipo } from '../../shared/handoffNotice'

/**
 * O barramento dos avisos de handoff no main: quem produz (a sessão, a fila)
 * publica; quem entrega (a janela por IPC, a ponte do celular) assina. Um
 * assinante que falha não derruba os outros nem quem publicou.
 */

type Listener = (notice: HandoffNotice) => void

const listeners = new Set<Listener>()

export function onHandoffNotice(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishHandoffNotice(convId: string, tipo: HandoffNoticeTipo, texto: string): HandoffNotice {
  const notice: HandoffNotice = { convId, tipo, texto: texto.slice(0, 500), at: Date.now() }
  for (const listener of listeners) {
    try {
      listener(notice)
    } catch (error) {
      console.warn('[handoff-aviso] assinante falhou:', error)
    }
  }
  return notice
}
