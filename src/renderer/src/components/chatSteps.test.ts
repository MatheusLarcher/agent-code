/**
 * O agrupamento único do chat resumido (chatSteps.ts): onde termina uma
 * resposta, a resposta sem texto, o pensamento, a resposta final, as notas,
 * o "em andamento", o subagente fora e o resumo por resposta.
 */
import { describe, expect, it } from 'vitest'
import type { UIMessage } from '../types'
import { buildChatRows, rowIndexOfUser, sameStep, stepActivity, stepFallback, stepHasLine, type ChatStep } from './chatSteps'

const user = (id: string, text = 'pedido', extra: Partial<UIMessage> = {}): UIMessage => ({ kind: 'user', id, text, ...extra }) as UIMessage
const say = (id: string, text: string, answer = false, final = true): UIMessage =>
  ({ kind: 'assistant-text', id, text, final, ...(answer ? { answer: true } : {}) }) as UIMessage
const think = (id: string): UIMessage => ({ kind: 'thinking', id, text: 'hmm' }) as UIMessage
const tool = (id: string, name: string, input: unknown = {}, done = true, parent: string | null = null): UIMessage =>
  ({ kind: 'tool-use', id, name, input, parentToolUseId: parent, ...(done ? { result: { isError: false, text: 'ok' } } : {}) }) as UIMessage

const ids = (ms: readonly UIMessage[]): string[] => ms.map((m) => (m as { id: string }).id)
const shape = (rows: ReturnType<typeof buildChatRows<UIMessage>>): string[] =>
  rows.map((r) => (r.type === 'msg' ? `msg:${(r.msg as { id: string }).id}` : `step:${r.id}[${r.text ? (r.text as { id: string }).id : '-'}|${ids(r.items).join(',')}]`))

describe('buildChatRows — cada resposta = texto + o que veio depois dele', () => {
  it('ferramentas antes do 1º texto formam resposta sem texto; cada texto leva as ferramentas seguintes', () => {
    const rows = buildChatRows(
      [user('u1'), tool('t1', 'Grep'), say('a1', 'Vou procurar.'), tool('t2', 'Read'), tool('t3', 'Read'), say('a2', 'Achei.'), tool('t4', 'Edit'), say('a3', 'Pronto.', true)],
      { busy: false }
    )
    expect(shape(rows)).toEqual(['msg:u1', 'step:t1[-|t1]', 'step:a1[a1|t2,t3]', 'step:a2[a2|t4]', 'step:a3[a3|]'])
    const final = rows.at(-1) as ChatStep<UIMessage>
    expect(final.final).toBe(true)
    expect(stepHasLine(final)).toBe(false) // resposta final inteira, sem linha
  })

  it('a resposta final fecha a resposta: ferramenta depois dela (sem pedido no meio) abre outra', () => {
    const rows = buildChatRows([user('u1'), say('a1', 'Pronto.', true), tool('t1', 'Grep'), say('a2', 'Outra.')], { busy: false })
    expect(shape(rows)).toEqual(['msg:u1', 'step:a1[a1|]', 'step:t1[-|t1]', 'step:a2[a2|]'])
  })

  it('pensamento solto antes do texto vai com ele; depois do texto, entra na resposta dele', () => {
    const rows = buildChatRows([user('u1'), think('k1'), say('a1', 'Vou ver.'), think('k2'), tool('t1', 'Read')], { busy: false })
    expect(shape(rows)).toEqual(['msg:u1', 'step:k1[a1|k1,k2,t1]'])
    const step = rows[1] as ChatStep<UIMessage>
    expect(step.tools.map((m) => (m as { id: string }).id)).toEqual(['t1'])
    // A chave é a do texto: a resposta final (que antes era narração) não remonta.
    expect(step.key).toBe('assistant:a1')
  })

  it('erro, aviso e troca de conta continuam linhas próprias e fecham a resposta aberta', () => {
    const status = { kind: 'status', id: 's1', text: 'compactando' } as UIMessage
    const rows = buildChatRows([user('u1'), say('a1', 'Vou.'), tool('t1', 'Read'), status, tool('t2', 'Edit')], { busy: false })
    expect(shape(rows)).toEqual(['msg:u1', 'step:a1[a1|t1]', 'msg:s1', 'step:t2[-|t2]'])
  })

  it('subagente fora (nem cartão, nem resumo); result e tool-result não viram linha', () => {
    const result = { kind: 'result', id: 'r', isError: false, text: '', durationMs: 1 } as UIMessage
    const rows = buildChatRows([user('u1'), say('a1', 'Delegando.'), tool('t1', 'Task'), tool('x1', 'Edit', {}, true, 't1'), tool('t2', 'Read'), result], {
      busy: false
    })
    expect(shape(rows)).toEqual(['msg:u1', 'step:a1[a1|t1,t2]'])
  })

  it('em andamento: só a última resposta do turno gira e mostra "agora: …"', () => {
    const msgs = [user('u1'), say('a1', 'Vou ler.'), tool('t1', 'Read', { file_path: '/p/a.ts' }), say('a2', 'Agora edito.'), tool('t2', 'Edit', { file_path: '/p/App.tsx' }, false)]
    const rows = buildChatRows(msgs, { busy: true })
    const [first, last] = rows.slice(1) as ChatStep<UIMessage>[]
    expect([first.running, last.running]).toEqual([false, true])
    expect(stepActivity(last).now).toBe('editando App.tsx…')
    // Parada, nada gira; a resposta final nunca gira.
    expect(buildChatRows(msgs, { busy: false }).some((r) => r.type === 'step' && r.running)).toBe(false)
    const done = buildChatRows([...msgs, say('a3', 'Pronto.', true)], { busy: true })
    expect(done.some((r) => r.type === 'step' && r.running)).toBe(false)
    // Ocupada mas ainda sem resposta depois do pedido novo: a resposta do turno anterior não gira.
    const waiting = buildChatRows([user('u1'), say('a1', 'Vou.'), tool('t1', 'Read'), user('u2')], { busy: true })
    expect(waiting.some((r) => r.type === 'step' && r.running)).toBe(false)
    // Ajuste injetado no meio do turno não encerra o turno.
    const injected = buildChatRows([user('u1'), say('a1', 'Vou.'), tool('t1', 'Read', {}, false), user('u2', 'agora', { injected: true })], { busy: true })
    expect((injected[1] as ChatStep<UIMessage>).running).toBe(true)
  })

  it('o resumo é o da Central, por resposta; bastidor sozinho e pensamento sozinho têm texto próprio', () => {
    const rows = buildChatRows(
      [user('u1'), say('a1', 'Vou procurar.'), tool('g', 'Grep', { pattern: 'send-btn' }), tool('r1', 'Read', { file_path: '/p/Composer.tsx' }), say('a2', 'Plano.'), tool('td', 'TodoWrite')],
      { busy: false }
    )
    const [s1, s2] = rows.slice(1) as ChatStep<UIMessage>[]
    const a1 = stepActivity(s1)
    expect([a1.text, a1.count]).toEqual(['Procurou "send-btn" · leu Composer.tsx', 2])
    const a2 = stepActivity(s2)
    expect(a2.count).toBe(0)
    expect(stepFallback(a2, s2.tools.length, 0)).toBe('usou 1 ferramenta')
    expect(stepFallback({ segments: [] }, 0, 1)).toBe('pensamento')
    expect(stepFallback(a1, 2, 0)).toBe('')
  })

  it('sameStep: a mesma resposta não redesenha; ferramenta nova ou resultado novo, sim', () => {
    const t1 = tool('t1', 'Read', {}, false)
    const base = [user('u1'), say('a1', 'Vou.'), t1]
    const a = buildChatRows(base, { busy: true })[1] as ChatStep<UIMessage>
    const b = buildChatRows([...base], { busy: true })[1] as ChatStep<UIMessage>
    expect(sameStep(a, b)).toBe(true)
    const c = buildChatRows([user('u1'), say('a1', 'Vou.'), { ...t1, result: { isError: false, text: 'ok' } } as UIMessage], { busy: true })[1] as ChatStep<UIMessage>
    expect(sameStep(a, c)).toBe(false)
  })

  it('rowIndexOfUser acha o pedido nas LINHAS (busca/mapa)', () => {
    const rows = buildChatRows([user('u1'), say('a1', 'x'), tool('t1', 'Read'), tool('t2', 'Read'), user('u2')], { busy: false })
    expect(rowIndexOfUser(rows, 'u2')).toBe(2)
    expect(rowIndexOfUser(rows, 'nada')).toBe(-1)
  })
})
