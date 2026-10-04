import { describe, expect, it } from 'vitest'
import type { PermissionRequest } from '@shared/ipc'
import type { CentralAnchor, CentralEntry } from '@shared/central'
import { answeredQuestionEntry, pendingConvIds } from './centralQuestions'

/**
 * Perguntas e permissões dos destinos (puro): só as das conversas com turno em
 * aberto na Central, e a linha de histórico que fica depois da resposta.
 */

const ask: PermissionRequest = {
  id: 'p1',
  toolName: 'AskUserQuestion',
  input: {},
  questions: [
    { header: 'Cor', question: 'Qual cor?', multiSelect: false, options: [{ label: 'Azul', description: '' }, { label: 'Verde', description: '' }] },
    { header: 'Tom', question: 'Qual tom?', multiSelect: true, options: [{ label: 'Claro', description: '' }] }
  ]
}
const bash: PermissionRequest = { id: 'p2', toolName: 'Bash', input: { command: 'npm test' } }

describe('pendingConvIds', () => {
  it('só as conversas com o turno de um pedido ancorado VIVO (resposta terminada ou ausente não decide)', () => {
    const entries: CentralEntry[] = [
      { kind: 'request', id: 'r1', ts: 1, text: 'a', state: 'delivered', anchor: { convId: 'c1', msgId: 'u1' } },
      { kind: 'request', id: 'r2', ts: 2, text: 'b', state: 'delivered', anchor: { convId: 'c2', msgId: 'u2' } },
      { kind: 'reply', id: 'reply:r2', ts: 3, requestId: 'r2', anchor: { convId: 'c2', msgId: 'u2' }, notes: [], activity: { segments: [], text: '', count: 0, errors: 0 }, done: true },
      // Pedido descartado (nada vivo com a âncora dele): nunca mais conta.
      { kind: 'request', id: 'r4', ts: 4, text: 'd', state: 'delivered', anchor: { convId: 'c4', msgId: 'u4' } }
    ]
    const live = (a: CentralAnchor): boolean => a.msgId === 'u1'
    expect(pendingConvIds(entries, { c1: ask, c2: bash, c3: bash, c4: bash }, live)).toEqual(['c1'])
  })
})

describe('answeredQuestionEntry', () => {
  it('pergunta respondida: as perguntas e as escolhas, com device', () => {
    const e = answeredQuestionEntry('c1', ask, { id: 'p1', behavior: 'allow', answers: [{ header: 'Cor', question: 'Qual cor?', selected: ['Azul'] }, { header: 'Tom', question: 'Qual tom?', selected: ['Claro', 'Escuro'] }] }, 'pc-1', 77)
    expect(e).toMatchObject({ kind: 'question', ts: 77, convId: 'c1', question: 'Qual cor? · Qual tom?', answer: 'Azul · Claro, Escuro', device: 'pc-1' })
    expect(e.id).toMatch(/^q-/)
  })

  it('permissão de ferramenta: o pedido descrito e a decisão; pergunta cancelada = sem resposta', () => {
    expect(answeredQuestionEntry('c2', bash, { id: 'p2', behavior: 'allow' }, undefined)).toMatchObject({ question: 'permissão: Bash npm test', answer: 'permitido' })
    expect(answeredQuestionEntry('c2', bash, { id: 'p2', behavior: 'allow', always: true }, undefined).answer).toBe('sempre permitido')
    expect(answeredQuestionEntry('c2', bash, { id: 'p2', behavior: 'deny' }, undefined).answer).toBe('negado')
    expect(answeredQuestionEntry('c1', ask, { id: 'p1', behavior: 'deny' }, undefined).answer).toBe('sem resposta')
    expect(answeredQuestionEntry('c2', bash, { id: 'p2', behavior: 'allow' }, undefined)).not.toHaveProperty('device')
  })
})
