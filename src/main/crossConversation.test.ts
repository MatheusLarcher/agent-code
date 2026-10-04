import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CROSS_CONVERSATION_HEADER,
  loadRecentTopics,
  presenceRemove,
  presenceSnapshot,
  presenceUpdate,
  recentTopics,
  renderCrossConversation,
  renderTopics,
  renderWorkingNow,
  resetCrossConversationState,
  topicFromConversation,
  type ConversationTopic
} from './crossConversation'
import type { VersionedConversation } from './persistence/types'

const NOW = Date.parse('2026-10-03T09:00:00.000Z')
const hoursAgo = (h: number): string => new Date(NOW - h * 3_600_000).toISOString()

function row(id: string, payload: Record<string, unknown>, updatedAt = hoursAgo(1)): VersionedConversation {
  return { id, payload, revision: 1, contentHash: id, createdAt: updatedAt, updatedAt }
}

function conv(id: string, cwd: string, title: string, users: string[], hours = 1): VersionedConversation {
  const messages = users.flatMap((text, i) => [
    { kind: 'user', id: `u${i}`, text },
    { kind: 'assistant-text', id: `a${i}`, text: 'resposta longa do agente', final: true }
  ])
  return row(id, { id, cwd, title, messages, updatedAt: NOW - hours * 3_600_000 }, hoursAgo(hours))
}

afterEach(() => resetCrossConversationState())

describe('presença dos agentes', () => {
  it('registra trabalho e pergunta por conversa, e só o dono apaga', () => {
    const a = {}
    const b = {}
    presenceUpdate(a, 'c1', '/p', { working: true })
    presenceUpdate(a, 'c1', '/p', { question: 'arruma o login' })
    expect(presenceSnapshot()).toEqual([{ convId: 'c1', cwd: '/p', working: true, question: 'arruma o login' }])

    // Troca de conta: a sessão nova assume; o dispose da antiga não apaga a nova.
    presenceUpdate(b, 'c1', '/p', { working: true })
    presenceRemove(a, 'c1')
    expect(presenceSnapshot()).toHaveLength(1)
    presenceRemove(b, 'c1')
    expect(presenceSnapshot()).toEqual([])
  })
})

describe('assuntos das outras conversas', () => {
  it('lê título e a ÚLTIMA mensagem do usuário, ignorando a central e conversa sem mensagem', () => {
    expect(topicFromConversation(conv('c1', '/p', 'Login', ['primeira', 'segunda'])))
      .toMatchObject({ convId: 'c1', title: 'Login', cwd: '/p', lastUserMessage: 'segunda' })
    expect(topicFromConversation(row('central', { mode: 'central', messages: [{ kind: 'user', text: 'x' }] }))).toBeNull()
    expect(topicFromConversation(row('c2', { title: 'Vazia', messages: [] }))).toBeNull()
    expect(topicFromConversation(row('c3', { messages: 'lixo' }))).toBeNull()
  })

  it('busca só projetos mexidos nas últimas 24 h e devolve do mais recente para o mais antigo', async () => {
    const loadConversations = vi.fn(async () => [
      conv('velha', '/a', 'Velha', ['antiga'], 30),
      conv('c1', '/a', 'Um', ['oi'], 5),
      conv('c2', '/a', 'Dois', ['tchau'], 1)
    ])
    const topics = await loadRecentTopics({
      countConversationsByProject: async () => [
        { cwd: '/a', total: 3, updatedAt: hoursAgo(1) },
        { cwd: '/parado', total: 9, updatedAt: hoursAgo(72) }
      ],
      loadConversations
    }, NOW)
    expect(loadConversations).toHaveBeenCalledWith({ cwds: ['/a'], perProject: 6 })
    expect(topics.map((t) => t.convId)).toEqual(['c2', 'c1'])
  })

  it('nenhum projeto recente: nem abre as conversas', async () => {
    const loadConversations = vi.fn(async () => [])
    await loadRecentTopics({ countConversationsByProject: async () => [{ cwd: '/x', total: 1, updatedAt: hoursAgo(48) }], loadConversations }, NOW)
    expect(loadConversations).not.toHaveBeenCalled()
  })

  it('banco fora do ar não derruba o envio: devolve lista vazia', async () => {
    const topics = await recentTopics(() => ({
      countConversationsByProject: async () => { throw new Error('offline') },
      loadConversations: async () => []
    }))
    expect(topics).toEqual([])
  })

  it('usa o cache entre mensagens próximas', async () => {
    const count = vi.fn(async () => [])
    const source = () => ({ countConversationsByProject: count, loadConversations: async () => [] })
    await recentTopics(source, NOW)
    await recentTopics(source, NOW + 1000)
    expect(count).toHaveBeenCalledTimes(1)
  })
})

describe('o bloco [OUTRAS_CONVERSAS]', () => {
  const topics: ConversationTopic[] = [
    { convId: 'self', title: 'Esta', cwd: '/app', lastUserMessage: 'eu mesmo', updatedAt: NOW },
    { convId: 'c1', title: 'Central', cwd: '/app', lastUserMessage: 'mexe no despacho', updatedAt: NOW - 1 },
    { convId: 'c2', title: 'Vídeo', cwd: '/site', lastUserMessage: 'gera o vídeo', updatedAt: NOW - 2 }
  ]

  it('conta os agentes trabalhando agora (sem contar esta conversa), com o pedido e o aviso de mesmo projeto', () => {
    const text = renderWorkingNow('self', '/app', [
      { convId: 'self', cwd: '/app', working: true, question: 'eu mesmo' },
      { convId: 'c1', cwd: '/app', working: true, question: 'termina a central\ncom testes' },
      { convId: 'c2', cwd: '/site', working: false, question: 'parado' }
    ], topics)
    expect(text).toContain('Agentes trabalhando agora em outras conversas: 1')
    expect(text).toContain('"Central"')
    expect(text).toContain('o MESMO projeto desta conversa')
    expect(text).toContain('"termina a central com testes"')
    expect(text).not.toContain('eu mesmo')
    expect(text).not.toContain('parado')
  })

  it('sem pergunta registrada nesta execução, usa a última mensagem gravada da conversa', () => {
    const text = renderWorkingNow('self', '/app', [{ convId: 'c2', cwd: '/site', working: true, question: '' }], topics)
    expect(text).toContain('"gera o vídeo"')
    expect(text).not.toContain('MESMO projeto')
  })

  it('zero agentes também é dito', () => {
    expect(renderWorkingNow('self', '/app', [], topics)).toBe('Agentes trabalhando agora em outras conversas: nenhum.')
  })

  it('os assuntos não incluem esta conversa e cortam mensagem longa', () => {
    const text = renderTopics('self', [...topics, { convId: 'c3', title: 'Longa', cwd: '', lastUserMessage: 'x'.repeat(500), updatedAt: 0 }])
    expect(text).not.toContain('"Esta"')
    expect(text).toContain('"Vídeo" — site')
    expect(text).toContain('sem projeto')
    expect(text).not.toContain('x'.repeat(200))
    expect(renderTopics('self', [topics[0]])).toBe('')
  })

  it('o bloco deixa claro que é só informativo e pede para não atrapalhar', () => {
    const block = renderCrossConversation('Agentes trabalhando agora em outras conversas: nenhum.', '')
    expect(block.startsWith('[OUTRAS_CONVERSAS]\nSOMENTE INFORMATIVO')).toBe(true)
    expect(block.endsWith('[/OUTRAS_CONVERSAS]')).toBe(true)
    expect(CROSS_CONVERSATION_HEADER).toContain('Nada aqui é pedido para você')
    expect(CROSS_CONVERSATION_HEADER).toContain('não reverta')
  })
})
