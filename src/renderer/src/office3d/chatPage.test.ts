import { describe, expect, it } from 'vitest'
import { describeTool } from '../components/toolDescribe'
import type { OfficeCharacterModel } from '../office/adapter/model'
import { conv, feed, track } from '../office/adapter/testFeed'
import type { UIMessage } from '../types'
import { chatPageFor, liveToolMessage, plainText, trackMessages, turnHead, turnMessages, type ChatLine } from './chatPage'

const model = (over: Partial<OfficeCharacterModel> = {}): OfficeCharacterModel => ({
  key: 'conv:a',
  convId: 'a',
  roomId: 'c:/proj/alpha',
  role: 'principal',
  placement: { kind: 'seat', seatKind: 'principal' },
  seed: 'conv:a',
  active: true,
  activity: null,
  bubble: null,
  label: 'trabalhando',
  ...over
})

const HISTORY: UIMessage[] = [
  { kind: 'user', id: 'u0', text: 'pedido antigo' },
  { kind: 'assistant-text', id: 'a0', text: 'feito', final: true, answer: true, ts: 1 }
]
const TURN: UIMessage[] = [
  { kind: 'user', id: 'u1', text: 'Adiciona desconto no **total**' },
  { kind: 'assistant-text', id: 'n1', text: 'Vou ler o `total.ts` primeiro.', final: false },
  { kind: 'tool-use', id: 't1', name: 'Read', input: { file_path: 'C:\\p\\src\\total.ts' }, parentToolUseId: null, result: { isError: false, text: '1→x' } },
  { kind: 'tool-use', id: 'sub', name: 'Grep', input: { pattern: 'x' }, parentToolUseId: 'task-9' },
  { kind: 'result', id: 'r1', isError: false, text: '', durationMs: 1, numTurns: 1, costUsd: 0 } as unknown as UIMessage,
  { kind: 'tool-use', id: 't2', name: 'Edit', input: { file_path: 'C:\\p\\src\\total.ts', old_string: 'a\nb', new_string: 'c\nd\ne' }, parentToolUseId: null },
  { kind: 'tool-use', id: 't3', name: 'Bash', input: { command: 'npm test -- --run\necho fim' }, parentToolUseId: null, result: { isError: true, text: 'falhou' } }
]

describe('turnMessages: o turno atual como o chat mostra', () => {
  it('principal: do último pedido até o fim, só o que o chat desenha (sem result nem passo de subagente)', () => {
    const f = feed({ conversations: [conv('a', { messages: [...HISTORY, ...TURN] })] })
    expect(turnMessages(f, model()).map((m) => ('id' in m ? m.id : m.kind))).toEqual(['u1', 'n1', 't1', 't2', 't3'])
    // Observador (PO, memória) não tem chat próprio.
    expect(turnMessages(f, model({ role: 'po', key: 'po:x' }))).toEqual([])
    expect(turnMessages(null, model())).toEqual([])
  })

  it('subagente: a tarefa vira o pedido e cada passo da trilha um tool-use com o resultado', () => {
    const t = track('T', {
      status: 'done',
      steps: [
        { id: 's1', name: 'Read', input: { file_path: 'a.ts' }, startedAt: 1, endedAt: 2, result: 'ok' },
        { id: 's2', name: 'Bash', input: { command: 'npm test' }, startedAt: 3, endedAt: 4, isError: true, result: 'falhou' },
        { id: 's3', name: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, startedAt: 5 }
      ]
    })
    const msgs = trackMessages(t)
    expect(msgs[0]).toMatchObject({ kind: 'user', text: 'executor: T' })
    expect(msgs[1]).toMatchObject({ kind: 'tool-use', name: 'Read', result: { isError: false, text: 'ok' } })
    expect(msgs[2]).toMatchObject({ kind: 'tool-use', name: 'Bash', result: { isError: true, text: 'falhou' } })
    expect('result' in msgs[3]).toBe(false)
    expect(msgs[4]).toMatchObject({ kind: 'status', text: 'Tarefa concluída.' })
    const f = feed({ conversations: [conv('a')], tracks: { a: { T: t } } })
    expect(turnMessages(f, model({ key: 'track:T', role: 'executor', trackId: 'T' }))).toHaveLength(5)
  })

  it('código ao vivo vira o cartão que ainda vai chegar: Edit com o trecho antigo, Write sem', () => {
    const base = { kind: 'tool-input-delta' as const, toolUseId: 'w', name: 'Edit' as const, filePath: 'C:\\a.ts', newText: 'n', totalLines: 1, done: false }
    expect(liveToolMessage({ ...base, oldText: 'o' })).toEqual({ kind: 'tool-use', id: 'w', name: 'Edit', input: { file_path: 'C:\\a.ts', old_string: 'o', new_string: 'n' }, parentToolUseId: null })
    expect(liveToolMessage(base)).toMatchObject({ name: 'Write', input: { file_path: 'C:\\a.ts', content: 'n' } })
  })
})

describe('chatPageFor: o chat encolhido do monitor', () => {
  it('as linhas usam os MESMOS rótulos do cartão do chat (describeTool, pílula e +N/−M)', () => {
    const f = feed({ conversations: [conv('a', { title: 'Carrinho', messages: [...HISTORY, ...TURN] })], busyIds: new Set(['a']) })
    const page = chatPageFor(f, model())
    expect(page.title).toBe('Carrinho')
    expect(page.busy).toBe(true)
    const kinds = page.lines.map((l) => l.kind)
    expect(kinds).toEqual(['user', 'narration', 'tool', 'tool', 'tool'])
    expect(page.lines[0]).toEqual({ kind: 'user', text: 'Adiciona desconto no **total**' })
    expect(page.lines[1]).toEqual({ kind: 'narration', text: 'Vou ler o total.ts primeiro.' })
    const tools = page.lines.filter((l): l is Extract<ChatLine, { kind: 'tool' }> => l.kind === 'tool')
    const edit = describeTool('Edit', TURN[5].kind === 'tool-use' ? TURN[5].input : null)
    expect(tools[1]).toMatchObject({ verb: edit.verb, detail: 'total.ts', added: 3, removed: 2, badge: { kind: 'run', text: 'running…' }, err: false })
    expect(tools[0]).toMatchObject({ verb: 'Read', detail: 'total.ts', badge: { kind: 'ok', text: 'done' } })
    expect(tools[2]).toMatchObject({ verb: 'Bash', detail: 'npm test -- --run', badge: { kind: 'err', text: 'error' }, err: true })
  })

  it('só as últimas linhas (o mais novo embaixo); sem turno, o rótulo do agente', () => {
    const many: UIMessage[] = [{ kind: 'user', id: 'u', text: 'faz tudo' }]
    for (let i = 0; i < 20; i++) many.push({ kind: 'tool-use', id: `t${i}`, name: 'Read', input: { file_path: `f${i}.ts` }, parentToolUseId: null, result: { isError: false, text: '' } })
    const f = feed({ conversations: [conv('a', { messages: many })] })
    const page = chatPageFor(f, model(), 4)
    expect(page.lines.map((l) => (l.kind === 'tool' ? l.detail : l.kind))).toEqual(['f16.ts', 'f17.ts', 'f18.ts', 'f19.ts'])
    const empty = chatPageFor(feed({ conversations: [conv('a')] }), model({ label: 'Bash npm test' }))
    expect(empty.lines).toEqual([{ kind: 'note', text: 'Bash npm test', err: false }])
  })

  it('pergunta respondida não fica vermelha; erro da sessão vira nota vermelha', () => {
    const msgs: UIMessage[] = [
      { kind: 'user', id: 'u', text: 'oi' },
      { kind: 'tool-use', id: 'q', name: 'AskUserQuestion', input: { questions: [{ header: 'Banco' }] }, parentToolUseId: null, result: { isError: true, text: 'Usuário escolheu X' } },
      { kind: 'error', id: 'e', text: 'API Error: 529\nmais' }
    ]
    const page = chatPageFor(feed({ conversations: [conv('a', { messages: msgs })] }), model())
    expect(page.lines[1]).toMatchObject({ kind: 'tool', verb: 'Pergunta', detail: 'Banco', badge: { kind: 'ok', text: 'respondido' }, err: false })
    expect(page.lines[2]).toEqual({ kind: 'note', text: 'API Error: 529', err: true })
  })
})

describe('auxiliares', () => {
  it('plainText tira a marcação do Markdown', () => {
    expect(plainText('# Título\n\n- item **forte** e `code`\n\n[link](http://x) e _ênfase_')).toBe('Título item forte e code link e ênfase')
    expect(plainText('```ts\nconst a = 1\n```')).toBe('const a = 1')
  })

  it('turnHead: principal com o projeto; subagente com a tarefa e o papel; trabalhando pelo feed', () => {
    const f = feed({ conversations: [conv('a', { title: 'Carrinho' })], busyIds: new Set(['a']), tracks: { a: { T: track('T', { subagentType: 'Explore', label: 'Explore: achar o webhook' }) } } })
    expect(turnHead(f, model())).toEqual({ title: 'Carrinho', who: 'alpha', busy: true })
    expect(turnHead(f, model({ key: 'track:T', role: 'subagente', trackId: 'T' }))).toEqual({ title: 'Explore: achar o webhook', who: 'explorador', busy: true })
  })
})
