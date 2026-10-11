// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { HandoffNoticeBridge } from './handoffNoticeBridge'
import { onHandoffNotice, publishHandoffNotice } from '../handoffTracking/handoffNotices'

describe('HandoffNoticeBridge — handoff-aviso no envelope SSE', () => {
  it('escreve { convId: office, event: { kind: handoff-aviso, … } } para cada celular', () => {
    const lines: string[] = []
    const bridge = new HandoffNoticeBridge((line) => lines.push(line))
    bridge.notice({ convId: 'c1', tipo: 'atencao', texto: 'ATENÇÃO: outra conversa mexeu em x.ts', at: 5 })
    expect(lines).toHaveLength(1)
    expect(lines[0].startsWith('data: ')).toBe(true)
    expect(lines[0].endsWith('\n\n')).toBe(true)
    expect(JSON.parse(lines[0].slice(6))).toEqual({
      convId: 'office',
      event: { kind: 'handoff-aviso', convId: 'c1', tipo: 'atencao', texto: 'ATENÇÃO: outra conversa mexeu em x.ts', at: 5 }
    })
  })

  it('o barramento entrega a cada assinante; um assinante com defeito não derruba os outros', () => {
    const got: string[] = []
    const offBad = onHandoffNotice(() => {
      throw new Error('quebrado')
    })
    const off = onHandoffNotice((n) => got.push(`${n.tipo}:${n.texto}`))
    publishHandoffNotice('c1', 'decisao', 'Decidido sozinho: A (recomendada) — pergunta: X')
    off()
    offBad()
    publishHandoffNotice('c1', 'fila', 'depois de sair')
    expect(got).toEqual(['decisao:Decidido sozinho: A (recomendada) — pergunta: X'])
  })
})
