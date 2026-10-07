/**
 * O RESUMO "DESDE QUE VOCÊ SAIU" no escritório (planning/awaySummary.ts): o App
 * publica a versão curta de cada resumo aberto, por projeto; o quadro 3D
 * (EngineBoard.tick) põe no balão do PO do projeto — o mesmo das falas do
 * quadro — quando a cabeça dele aparece na tela, com a janela em foco (a câmera
 * chegou na sala ou no quadro). Uma vez por resumo; quem ouve `onSaid` (o App)
 * lê em voz alta. Módulo e não prop: o motor nasce uma vez e lê daqui no tique.
 */

export interface AwayAnnouncement {
  /** Um por resumo (projeto + volta): o mesmo resumo não é dito duas vezes. */
  id: string
  cwd: string
  text: string
}

let pending: AwayAnnouncement[] = []
const said = new Set<string>()
const listeners = new Set<(a: AwayAnnouncement) => void>()

export const awayAnnounce = {
  /** Os resumos abertos agora (o "ok" tira o do projeto). */
  publish(list: readonly AwayAnnouncement[]): void {
    pending = list.filter((a) => !said.has(a.id))
  },
  pending(): readonly AwayAnnouncement[] {
    return pending
  },
  /** O PO disse: sai da fila e avisa quem lê em voz alta. */
  markSaid(a: AwayAnnouncement): void {
    if (said.has(a.id)) return
    said.add(a.id)
    pending = pending.filter((x) => x.id !== a.id)
    for (const cb of listeners) cb(a)
  },
  onSaid(cb: (a: AwayAnnouncement) => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  },
  /** Só testes. */
  reset(): void {
    pending = []
    said.clear()
    listeners.clear()
  }
}
