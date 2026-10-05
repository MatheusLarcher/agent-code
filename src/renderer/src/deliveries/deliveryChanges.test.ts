import { describe, expect, it } from 'vitest'
import type { HandoffEnvio } from '@shared/handoffTracking'
import { entrega, envio } from '../handoffTracking/handoffFixtures'
import { deliveryNotices } from './deliveryChanges'

/** Envio com duas etapas, a 1ª em andamento. */
function base(over: Partial<HandoffEnvio> = {}): HandoffEnvio {
  return envio({
    projectCwd: 'C:\\GitHub\\loja',
    entregas: [
      entrega({ id: 'n1', etapaTitulo: 'Backend', ordem: 1, status: 'em_andamento' }),
      entrega({ id: 'n2', etapaTitulo: 'Tela', ordem: 2 })
    ],
    ...over
  })
}

function withEntrega(e: HandoffEnvio, id: string, over: Partial<HandoffEnvio['entregas'][number]>): HandoffEnvio {
  return { ...e, entregas: e.entregas.map((x) => (x.id === id ? { ...x, ...over } : x)) }
}

describe('deliveryNotices — o que vira toast entre duas leituras', () => {
  it('sem mudança, nada', () => {
    expect(deliveryNotices([base()], [base()])).toEqual([])
  })

  it('entrega concluída: sucesso, com etapa, plano e projeto, e a conversa do envio', () => {
    const next = withEntrega(base(), 'n1', { status: 'concluida' })
    expect(deliveryNotices([base()], [next])).toEqual([
      { kind: 'concluida', tipo: 'sucesso', msg: 'Entrega concluída: Backend — Checkout com Pix · loja', conversationId: 'conv-1' }
    ])
  })

  it('envio inteiro concluído: um aviso só (a última entrega não repete)', () => {
    const prev = withEntrega(base(), 'n1', { status: 'concluida' })
    const next = { ...withEntrega(prev, 'n2', { status: 'concluida' }), status: 'concluida' as const }
    const out = deliveryNotices([prev], [next])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'concluida', tipo: 'sucesso', msg: 'Envio concluído: Checkout com Pix · loja (Implementação)' })
  })

  it('incompleta: a entrega avisa (aviso) e o envio incompleto da mesma leitura não repete', () => {
    const next = { ...withEntrega(base(), 'n1', { status: 'incompleta' }), status: 'incompleta' as const }
    const out = deliveryNotices([base()], [next])
    expect(out).toEqual([
      { kind: 'incompleta', tipo: 'aviso', msg: 'Entrega incompleta: Backend — Checkout com Pix · loja', conversationId: 'conv-1' }
    ])
  })

  it('envio incompleto sem entrega marcada: o envio avisa', () => {
    const out = deliveryNotices([base()], [base({ status: 'incompleta' })])
    expect(out.map((n) => [n.kind, n.tipo])).toEqual([['incompleta', 'aviso']])
    expect(out[0].msg).toBe('Envio incompleto: Checkout com Pix · loja (Implementação)')
  })

  it('parado: aviso do envio', () => {
    const out = deliveryNotices([base()], [base({ status: 'parada' })])
    expect(out).toEqual([
      { kind: 'parada', tipo: 'aviso', msg: 'Envio parado: Checkout com Pix · loja (Implementação)', conversationId: 'conv-1' }
    ])
  })

  it('atrasado (false → true): aviso da entrega; sem entrega marcada, do envio', () => {
    const late = { ...withEntrega(base(), 'n1', { atrasada: true }), atrasado: true }
    expect(deliveryNotices([base()], [late]).map((n) => n.msg)).toEqual(['Entrega atrasada: Backend — Checkout com Pix · loja'])
    expect(deliveryNotices([base()], [base({ atrasado: true })]).map((n) => n.msg)).toEqual([
      'Envio atrasado: Checkout com Pix · loja (Implementação)'
    ])
    // Continuar atrasado não avisa de novo.
    expect(deliveryNotices([late], [late])).toEqual([])
  })

  it('envio que aparece pela primeira vez não avisa (não houve transição vista)', () => {
    expect(deliveryNotices([], [base({ status: 'concluida', atrasado: true })])).toEqual([])
  })

  it('a correção feita por você não vira aviso de mudança', () => {
    const next = {
      ...withEntrega(base(), 'n1', { status: 'concluida', corrigidoPor: 'usuario' as const, corrigidoEm: '2026-10-05T13:00:00.000Z' }),
      status: 'concluida' as const
    }
    expect(deliveryNotices([base()], [next])).toEqual([])
  })

  it('avisa de qualquer projeto: cada envio leva a conversa dele', () => {
    const a = base({ id: 'a', conversationId: 'conv-a', projectCwd: '/p/um' })
    const b = base({ id: 'b', conversationId: 'conv-b', projectCwd: '/p/dois' })
    const out = deliveryNotices([a, b], [{ ...a, status: 'parada' }, { ...b, status: 'parada' }])
    expect(out.map((n) => n.conversationId)).toEqual(['conv-a', 'conv-b'])
    expect(out.map((n) => n.msg)).toEqual([
      'Envio parado: Checkout com Pix · um (Implementação)',
      'Envio parado: Checkout com Pix · dois (Implementação)'
    ])
  })
})
