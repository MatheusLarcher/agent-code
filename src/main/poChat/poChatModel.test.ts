import { describe, expect, it } from 'vitest'
import { sourcesSentence, type PoChatMessage } from '../../shared/poChat'
import { parsePoChatReply, poChatPrompt, type PoChatContext } from './poChatModel'

/**
 * "Fala, PO" sem modelo: o pedido leva as regras, só as últimas ~10 trocas, o
 * contexto com referências e a pergunta; a resposta vira texto limpo, fontes
 * que existem (chips, com a miniatura do print) e opções (botões).
 */

const NOW = Date.UTC(2026, 9, 7, 12, 0)
const MIN = 60_000

const ctx: PoChatContext = {
  projectName: 'loja',
  boardAt: NOW - 2 * MIN,
  cards: [
    { id: 'card-login', conversationId: 'conv-a', title: 'Tela de login', status: 'concluído', poReason: null, awaiting: null, deadline: null, prints: 1, thumbUrl: 'data:image/jpeg;base64,MINI', updatedAt: '2026-10-07T11:50:00.000Z' },
    { id: 'card-api', conversationId: 'conv-b', title: 'API de login', status: 'a fazer', poReason: 'o turno terminou sem concluir esta tarefa', awaiting: 'Aguardando você', deadline: null, prints: 0, thumbUrl: null, updatedAt: '2026-10-07T11:40:00.000Z' }
  ],
  conversations: [
    { id: 'conv-a', title: 'Implementação: Login', lastAnswer: 'Terminei a tela de login e testei no navegador.', lastAt: NOW - 12 * MIN },
    { id: 'conv-b', title: 'Backend', lastAnswer: null, lastAt: null }
  ],
  queue: [{ plan: 'Plano Login', label: 'Prompt 2 de 3', estado: 'esperando a vez', motivo: null, conversationTitle: 'Implementação: Login' }],
  tasks: [{ title: 'Revisar o tema escuro', status: 'pending' }]
}

describe('poChatPrompt', () => {
  it('as regras, só as últimas 10 trocas, o contexto com referências e a pergunta', () => {
    const history: PoChatMessage[] = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'po' : 'usuario', text: `mensagem ${i}`, at: NOW - (30 - i) * MIN }))
    const prompt = poChatPrompt({ ctx, history, question: 'O que falta fazer?', now: NOW })
    expect(prompt).toMatch(/Você é o PO deste projeto, no chat "Fala, PO"/)
    expect(prompt).not.toMatch(/mensagem 9\b/)
    expect(prompt).toMatch(/USUÁRIO: mensagem 10/)
    expect(prompt).toMatch(/PO: mensagem 29/)
    expect(prompt).toMatch(/\[K1\] concluído — "Tela de login" \(conversa C1\) — 1 print\(s\)/)
    expect(prompt).toMatch(/\[K2\] a fazer — "API de login" \(conversa C2\) — Aguardando você · motivo: o turno terminou/)
    expect(prompt).toMatch(/\[C1\] "Implementação: Login" \(há 12 min\): Terminei a tela de login/)
    expect(prompt).toMatch(/Plano Login · Prompt 2 de 3 · esperando a vez/)
    expect(prompt.trim().endsWith('O que falta fazer?')).toBe(true)
  })
})

describe('parsePoChatReply', () => {
  it('fontes que existem viram chips (com a miniatura do print); referência inventada cai fora', () => {
    const raw = [
      'A tela de login está concluída [K1], segundo o agente [C1]. A API espera você [K2] [K9].',
      'NAO_CONFIRMADO: ninguém conferiu a tela de login no código',
      'VERIFICAR: 4',
      'ABRIR: K2, K7'
    ].join('\n')
    const reply = parsePoChatReply(raw, ctx, 'O que falta fazer?')
    expect(reply.text).toBe('A tela de login está concluída, segundo o agente. A API espera você.')
    expect(reply.sources).toEqual([
      { kind: 'conversa', conversationId: 'conv-a', title: 'Implementação: Login', at: NOW - 12 * MIN },
      { kind: 'quadro', at: NOW - 2 * MIN },
      { kind: 'card', cardId: 'card-login', conversationId: 'conv-a', title: 'Tela de login', thumbUrl: 'data:image/jpeg;base64,MINI' },
      { kind: 'card', cardId: 'card-api', conversationId: 'conv-b', title: 'API de login', thumbUrl: null }
    ])
    expect(reply.unconfirmed).toBe('ninguém conferiu a tela de login no código')
    expect(reply.options).toEqual([
      { kind: 'verificar', minutes: 4, question: 'O que falta fazer?' },
      { kind: 'abrir-card', cardId: 'card-api', conversationId: 'conv-b', title: 'API de login' }
    ])
    expect(sourcesSentence(reply.sources, NOW)).toBe("Com base na última resposta do agente da conversa 'Implementação: Login' (há 12 min) e no quadro (atualizado há 2 min).")
  })

  it('verificação entre 1 e 15 min; sem nada a conferir, sem botão', () => {
    expect(parsePoChatReply('ok\nVERIFICAR: 40', ctx, 'q').options).toEqual([{ kind: 'verificar', minutes: 15, question: 'q' }])
    expect(parsePoChatReply('ok\nVERIFICAR: 0', ctx, 'q').options[0]).toMatchObject({ minutes: 1 })
    expect(parsePoChatReply('ok\nNAO_CONFIRMADO: x', ctx, 'q').options[0]).toMatchObject({ kind: 'verificar', minutes: 5 })
    expect(parsePoChatReply('Tudo certo pelo quadro [K1].', ctx, 'q').options).toEqual([])
  })

  it('MANDAR: uma proposta por conversa dona dos cartões', () => {
    const reply = parsePoChatReply('Falta a API [K2].\nMANDAR: K2, K1', ctx, 'q')
    expect(reply.options).toEqual([
      expect.objectContaining({ kind: 'mandar', conversationId: 'conv-b', conversationTitle: 'Backend', cardIds: ['card-api'], titles: ['API de login'] }),
      expect.objectContaining({ kind: 'mandar', conversationId: 'conv-a', conversationTitle: 'Implementação: Login', cardIds: ['card-login'], titles: ['Tela de login'] })
    ])
  })

  it('resposta sem fonte: a frase diz isso', () => {
    const reply = parsePoChatReply('Não sei.', ctx, 'q')
    expect(reply.sources).toEqual([])
    expect(sourcesSentence(reply.sources, NOW)).toMatch(/^Sem fonte/)
  })
})
