/**
 * A Central com resumo por resposta: `mirrorTurn` devolve os passos (o mesmo
 * agrupamento do chat), a entrada guardada ganha `steps` sem perder `notes` /
 * `activity`, o retrato do celular leva os passos prontos (e nada quando a
 * entrada é antiga) e o bloco do PC desenha cada comentário com a sua linha —
 * entrada antiga continua no desenho de antes.
 */
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { CENTRAL_ID, type CentralEntry, type CentralReplyEntry, type CentralRequestEntry } from '@shared/central'
import { UiProvider } from '../ui/UiProvider'
import type { Conversation, UIMessage } from '../types'
import { resetStepOpen } from '../components/useStepOpen'
import { CentralPanel } from './CentralPanel'
import { capSteps, MAX_REPLY_STEPS } from './centralEntries'
import { fakeController, fakeLabel } from './centralFakeController'
import { mirrorTurn } from './centralMirror'
import { planMirror } from './centralMirrorSync'
import { buildRemoteCentral } from './centralRemote'

const OK = { isError: false, text: 'ok' }
const user = (id: string): UIMessage => ({ kind: 'user', id, text: `pedido ${id}` }) as UIMessage
const say = (id: string, text: string, o: { answer?: boolean; final?: boolean } = {}): UIMessage =>
  ({ kind: 'assistant-text', id, text, final: o.final ?? true, ...(o.answer ? { answer: true } : {}) }) as UIMessage
const tool = (id: string, name: string, input: unknown, done = true, parent: string | null = null): UIMessage =>
  ({ kind: 'tool-use', id, name, input, parentToolUseId: parent, ...(done ? { result: OK } : {}) }) as UIMessage

const turn: UIMessage[] = [
  user('u1'),
  say('a1', 'Vou procurar o campo.'),
  tool('g', 'Grep', { pattern: 'send-btn' }),
  tool('r', 'Read', { file_path: '/p/Composer.tsx' }),
  tool('sub', 'Edit', { file_path: '/p/x.ts' }, true, 'g'), // subagente: fora
  say('a2', 'Achei a causa.'),
  tool('e', 'Edit', { file_path: '/p/Composer.tsx', old_string: 'a', new_string: 'b' }),
  say('a3', 'Pronto.', { answer: true })
]

describe('mirrorTurn — os passos do turno', () => {
  it('cada comentário com o resumo e os ids SÓ das ferramentas dele; a resposta final fica em `answer`', () => {
    const m = mirrorTurn(turn, 'u1', false)!
    expect(m.notes).toEqual(['Vou procurar o campo.', 'Achei a causa.'])
    expect(m.answer).toBe('Pronto.')
    expect(m.steps).toEqual([
      { note: 'Vou procurar o campo.', activity: expect.objectContaining({ text: 'Procurou "send-btn" · leu Composer.tsx', count: 2 }), toolIds: ['g', 'r'] },
      { note: 'Achei a causa.', activity: expect.objectContaining({ text: 'Editou Composer.tsx +1 −1', count: 1 }), toolIds: ['e'] }
    ])
  })

  it('ferramentas antes do 1º texto: passo sem comentário; rodando: só o último gira com o "agora"', () => {
    const live = [user('u1'), tool('g', 'Grep', { pattern: 'x' }), say('a1', 'Vou editar.'), tool('e', 'Edit', { file_path: '/p/App.tsx' }, false)]
    const m = mirrorTurn(live, 'u1', true)!
    expect(m.steps.map((s) => [s.note ?? null, s.toolIds, s.activity.now ?? null])).toEqual([
      [null, ['g'], null],
      ['Vou editar.', ['e'], 'editando App.tsx…']
    ])
    // Texto parcial (streaming) nunca vira comentário.
    const partial = mirrorTurn([user('u1'), say('a1', 'Vou ed', { final: false })], 'u1', true)!
    expect(partial.steps).toEqual([{ activity: expect.objectContaining({ count: 0 }), toolIds: [] }])
  })

  it('a entrada gravada ganha `steps` (com teto) e continua com `notes` e `activity`', () => {
    const request: CentralRequestEntry = { kind: 'request', id: 'r1', ts: 1, text: 'x', state: 'delivered', anchor: { convId: 'c', msgId: 'u1' } }
    const conv = { id: 'c', messages: turn } as Conversation
    const plan = planMirror({ entries: [request], convs: new Map([['c', conv]]), busy: new Set(), self: undefined, now: 5 })
    const reply = plan.upserts[0]
    expect(reply.notes).toEqual(['Vou procurar o campo.', 'Achei a causa.'])
    expect(reply.activity.count).toBe(3)
    expect(reply.steps?.map((s) => s.toolIds)).toEqual([['g', 'r'], ['e']])
    const many = Array.from({ length: 20 }, (_, i) => ({ note: 'n'.repeat(700), activity: reply.activity, toolIds: Array.from({ length: 80 }, (_, k) => `t${i}-${k}`) }))
    const capped = capSteps(many)
    expect(capped).toHaveLength(MAX_REPLY_STEPS)
    expect(capped[0].note?.length).toBe(600)
    expect(capped[0].toolIds).toHaveLength(60)
  })
})

const reply = (over: Partial<CentralReplyEntry> = {}): CentralReplyEntry => ({
  kind: 'reply',
  id: 'reply:r1',
  ts: 2,
  requestId: 'r1',
  anchor: { convId: 'darj', msgId: 'u1' },
  notes: ['Vou procurar o campo.', 'Achei a causa.'],
  answer: 'Pronto.',
  activity: { segments: [{ text: 'Fez 3 coisas' }], text: 'Fez 3 coisas', count: 3, errors: 0 },
  done: true,
  ...over
})
const steps = mirrorTurn(turn, 'u1', false)!.steps

describe('retrato do celular — steps opcional', () => {
  it('com passos: vão prontos (resumo e ids); sem passos (entrada antiga): nada muda', () => {
    const src = (entries: CentralEntry[]) => ({ entries, rail: [], pending: [], labelFor: fakeLabel })
    const [withSteps] = buildRemoteCentral(src([reply({ steps })])).entries
    expect(withSteps.kind === 'reply' && withSteps.steps?.map((s) => [s.note, s.toolIds, s.activity.text])).toEqual([
      ['Vou procurar o campo.', ['g', 'r'], 'Procurou "send-btn" · leu Composer.tsx'],
      ['Achei a causa.', ['e'], 'Editou Composer.tsx +1 −1']
    ])
    expect(withSteps.kind === 'reply' && withSteps.notes).toEqual(['Vou procurar o campo.', 'Achei a causa.'])
    const [old] = buildRemoteCentral(src([reply()])).entries
    expect(old.kind === 'reply' && 'steps' in old).toBe(false)
    // Dado torto de outra versão não derruba o retrato.
    const [bad] = buildRemoteCentral(src([reply({ steps: [null, { note: 3, activity: null, toolIds: 'x' }] as unknown as CentralReplyEntry['steps'] })])).entries
    expect(bad.kind === 'reply' && bad.steps).toEqual([{ activity: { segments: [], text: '', count: 0, errors: 0 }, toolIds: [] }])
  })
})

describe('CentralPanel — bloco com resumo por resposta', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    ;(window as unknown as { api: unknown }).api = { mentionSearch: vi.fn(async () => []) }
    resetStepOpen()
  })
  afterEach(cleanup)

  const mount = (entries: CentralEntry[]) =>
    render(
      <UiProvider>
        <CentralPanel
          conversation={{ id: CENTRAL_ID, title: 'Central', cwd: '', mode: 'central', messages: [] } as unknown as Conversation}
          controller={fakeController({ entries, tools: { 'darj:u1': turn.filter((m) => m.kind === 'tool-use' && m.parentToolUseId == null) } })}
          ready
          onNeedTypesafe={vi.fn()}
          onSend={vi.fn()}
          onDraftChange={vi.fn()}
          composerRef={createRef<HTMLElement>()}
          projects={[]}
        />
      </UiProvider>
    ).container

  it('cada comentário com a sua linha; o clique abre só os cartões daquele passo; resposta e "abrir conversa" no fim', () => {
    const box = mount([reply({ steps })])
    const block = box.querySelector<HTMLElement>('.central-agent')!
    const order = [...block.children].map((el) => el.className.split(' ')[0]).filter((c) => c !== 'central-reply-btn')
    expect(order).toEqual(['central-who', 'central-note', 'central-act', 'central-note', 'central-act', 'central-answer', 'central-open'])
    const lines = block.querySelectorAll<HTMLElement>('.central-act')
    expect(lines[0].querySelector('.central-sum')?.textContent).toBe('Procurou "send-btn" · leu Composer.tsx')
    fireEvent.click(lines[1])
    expect([...block.querySelectorAll('.tool-card .tool-name')].map((n) => n.textContent)).toEqual(['Edit'])
    fireEvent.click(lines[1])
    expect(block.querySelector('.tool-card')).toBeNull()
  })

  it('entrada antiga (sem steps): o desenho de antes — notas, resposta e UMA linha do turno inteiro', () => {
    const box = mount([reply()])
    const block = box.querySelector<HTMLElement>('.central-agent')!
    expect(block.querySelectorAll('.central-note')).toHaveLength(2)
    const lines = block.querySelectorAll<HTMLElement>('.central-act')
    expect(lines).toHaveLength(1)
    fireEvent.click(lines[0])
    expect(block.querySelectorAll('.tool-card')).toHaveLength(3)
  })
})
