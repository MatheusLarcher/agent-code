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

describe('deliveryNotices — a fila do quadro', () => {
  const queued = (over: Partial<HandoffEnvio> = {}): HandoffEnvio =>
    base({ id: 'env-2', ordem: 2, status: 'na_fila', enviadoEm: null, entregas: [], ...over })

  it('o envio corrente parou pelo Stop (ou com erro) com prompts esperando: um aviso "a fila parou" no lugar do parado', () => {
    const prev = [base({ status: 'em_execucao' }), queued()]
    const next = [base({ status: 'parada', motivo: 'você parou este prompt (Stop) — a fila espera você' }), queued()]
    expect(deliveryNotices(prev, next).map((n) => [n.kind, n.msg])).toEqual([
      ['fila', 'A fila parou: Checkout com Pix · loja — 1 prompt espera no quadro']
    ])
    expect(deliveryNotices(prev, [base({ status: 'falhou' }), queued()]).map((n) => n.kind)).toEqual(['fila'])
    // Sem nada esperando, o aviso de sempre.
    expect(deliveryNotices([prev[0]], [next[0]]).map((n) => n.kind)).toEqual(['parada'])
  })

  it('incompleto com prompts esperando: a fila NÃO parou (segue sozinha) — só o aviso do incompleto', () => {
    const prev = [base({ status: 'em_execucao' }), queued()]
    const next = [base({ status: 'incompleta', motivo: 'faltou [b]' }), queued()]
    expect(deliveryNotices(prev, next).map((n) => n.kind)).toEqual(['incompleta'])
  })

  it('o prompt seguinte sai sozinho com a pendência do anterior: "Envio N/M saiu sozinho…"', () => {
    const prev = [base({ status: 'incompleta', motivo: 'faltou [b]' }), queued()]
    const next = [base({ status: 'incompleta', motivo: 'faltou [b]' }), queued({ status: 'enviado', enviadoEm: '2026-10-10T10:00:00.000Z' })]
    expect(deliveryNotices(prev, next).map((n) => [n.kind, n.tipo, n.msg])).toEqual([
      ['fila', 'aviso', 'Envio 2/2 saiu sozinho com a pendência do anterior: faltou [b] — Checkout com Pix · loja']
    ])
  })

  it('o envio parado por inatividade volta a enviado: "Envio N/M retomado…"', () => {
    const stall = 'nenhum turno rodando há 10 min, sem pergunta pendente e sem conclusão'
    const prev = [base({ status: 'parada', motivo: stall }), queued()]
    const next = [base({ status: 'enviado', motivo: null }), queued()]
    expect(deliveryNotices(prev, next).map((n) => n.msg)).toEqual(['Envio 1/2 retomado depois de parar por inatividade — Checkout com Pix · loja'])
    // A 1ª parada por inatividade não diz "a fila parou" (ela vai retomar).
    expect(deliveryNotices([base({ status: 'em_execucao' }), queued()], prev).map((n) => n.kind)).toEqual(['parada'])
  })

  it('o PO segurou o próximo prompt: avisa com o motivo; tirar da fila (ação sua) não avisa', () => {
    const held = queued({ motivo: 'o PO segurou: a etapa 1 já fez isso' })
    expect(deliveryNotices([base(), queued()], [base(), held]).map((n) => n.msg)).toEqual([
      'O PO segurou o próximo prompt: a etapa 1 já fez isso — Checkout com Pix · loja'
    ])
    const removed = queued({ status: 'parada', motivo: 'tirado da fila por você' })
    expect(deliveryNotices([base(), queued()], [base(), removed])).toEqual([])
  })
})
