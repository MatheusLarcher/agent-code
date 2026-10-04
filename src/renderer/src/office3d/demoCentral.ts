/**
 * A Central na demonstração: três despachos por loop — para a conversa Demo 2.1
 * (o pulso corre do console até a mesa dela), uma conversa nova num projeto
 * (até a ilha dele) e um sandbox novo (até a porta). Cada loop tem ids novos,
 * então o pulso corre de novo a cada volta.
 */
import type { CentralRequestEntry, CentralState, CentralTarget } from '@shared/central'

const DISPATCHES: ReadonlyArray<{ at: number; text: string; target: (cwdOf: (room: number) => string) => CentralTarget }> = [
  { at: 18_000, text: 'Confere o frete do carrinho.', target: (cwdOf) => ({ kind: 'conversation', convId: 'demo-1-0', cwd: cwdOf(1), project: cwdOf(1).split('\\').pop() ?? '', title: 'Demo 2.1', sandbox: false }) },
  { at: 86_000, text: 'Começa a tela de notas do portal.', target: (cwdOf) => ({ kind: 'new-conversation', cwd: cwdOf(3), project: cwdOf(3).split('\\').pop() ?? '' }) },
  { at: 104_000, text: 'Testa uma ideia solta num rascunho.', target: () => ({ kind: 'new-sandbox' }) }
]

/** As entradas da Central já entregues na fase `t` do loop. */
export function demoCentralState(t: number, start: number, cycle: number, cwdOf: (room: number) => string): CentralState {
  const entries: CentralRequestEntry[] = []
  DISPATCHES.forEach((d, i) => {
    if (t < d.at) return
    const target = d.target(cwdOf)
    entries.push({
      kind: 'request',
      id: `demo-central-${cycle}-${i}`,
      ts: start + d.at,
      text: d.text,
      state: 'delivered',
      route: { target, why: 'demonstração' },
      ...(target.kind === 'conversation' ? { anchor: { convId: target.convId, msgId: `demo-central-${cycle}-${i}` } } : {})
    })
  })
  return { entries }
}
