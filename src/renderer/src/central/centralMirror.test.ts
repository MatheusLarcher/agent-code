import { describe, expect, it } from 'vitest'
import type { UIMessage } from '../types'
import { mirrorTurn, turnToolUses } from './centralMirror'

type Res = { isError: boolean; text: string }
const OK: Res = { isError: false, text: 'ok' }

const user = (id: string, injected = false): UIMessage => ({ kind: 'user', id, text: `pedido ${id}`, ...(injected ? { injected: true } : {}) })
const text = (id: string, t: string, o: { final?: boolean; answer?: boolean } = {}): UIMessage => ({
  kind: 'assistant-text',
  id,
  text: t,
  final: o.final ?? true,
  ...(o.answer ? { answer: true } : {})
})
const tool = (id: string, name: string, input: unknown, o: { parent?: string; result?: Res } = {}): UIMessage => ({
  kind: 'tool-use',
  id,
  name,
  input,
  parentToolUseId: o.parent ?? null,
  ...(o.result ? { result: o.result } : {})
})
// Sem helper de `result`: o evento nunca entra em `messages` (App.tsx, reduceMessages) — só marca
// a última assistant-text com `answer: true`. É essa marca que os testes usam.
const thinking = (id: string): UIMessage => ({ kind: 'thinking', id, text: 'pensando…' })
const read = (id: string, file: string, res?: Res): UIMessage => tool(id, 'Read', { file_path: file }, { result: res })

describe('mirrorTurn — o turno e a âncora', () => {
  it('âncora fora das mensagens (a mensagem ainda está na fila): null', () => {
    expect(mirrorTurn([user('u0'), text('t0', 'oi')], 'u1', false)).toBeNull()
    expect(mirrorTurn([], 'u1', true)).toBeNull()
  })

  it('a âncora é uma mensagem do usuário: um id igual em outro tipo de mensagem não vale', () => {
    expect(mirrorTurn([text('u1', 'oi')], 'u1', false)).toBeNull()
    expect(turnToolUses([tool('u1', 'Read', {})], 'u1')).toEqual([])
  })

  it('só a âncora, nada depois: o turno ainda não começou', () => {
    const m = mirrorTurn([user('u1')], 'u1', true)
    expect(m).not.toBeNull()
    expect(m).toMatchObject({ notes: [], tools: [], done: false, started: false })
    expect(m?.answer).toBeUndefined()
    expect(m?.activity).toEqual({ segments: [], text: '', count: 0, errors: 0 })
  })

  it('começou: qualquer mensagem depois da âncora (até um pensamento) conta', () => {
    expect(mirrorTurn([user('u1'), thinking('th1')], 'u1', true)?.started).toBe(true)
  })

  it('o turno vai da âncora até a próxima mensagem do usuário', () => {
    const msgs = [
      user('u0'),
      text('t0', 'turno anterior', { answer: true }),
      user('u1'),
      text('t1', 'Do turno.'),
      user('u2'),
      text('t2', 'Do turno seguinte.')
    ]
    expect(mirrorTurn(msgs, 'u1', false)?.notes).toEqual(['Do turno.'])
    expect(mirrorTurn(msgs, 'u0', false)?.answer).toBe('turno anterior')
    expect(mirrorTurn(msgs, 'u2', false)?.notes).toEqual(['Do turno seguinte.'])
  })

  it('não altera a lista de entrada', () => {
    const msgs = [user('u1'), text('t1', 'a'), read('k1', 'a.ts', OK)]
    const snapshot = JSON.stringify(msgs)
    mirrorTurn(msgs, 'u1', true)
    turnToolUses(msgs, 'u1')
    expect(JSON.stringify(msgs)).toBe(snapshot)
  })
})

describe('mirrorTurn — comentários e resposta', () => {
  it('os textos finais viram notes, na ordem; o marcado answer vira a resposta', () => {
    const msgs = [
      user('u1'),
      text('t1', 'Achei o filtro em filtros.js.'),
      read('k1', 'filtros.js', OK),
      text('t2', 'Testes passaram.'),
      text('t3', 'Pronto: o filtro agora ignora a máscara.', { answer: true })
    ]
    const m = mirrorTurn(msgs, 'u1', false)
    expect(m?.notes).toEqual(['Achei o filtro em filtros.js.', 'Testes passaram.'])
    expect(m?.answer).toBe('Pronto: o filtro agora ignora a máscara.')
  })

  it('sem texto marcado como resposta: tudo são comentários e a resposta fica ausente', () => {
    const m = mirrorTurn([user('u1'), text('t1', 'a'), text('t2', 'b')], 'u1', true)
    expect(m?.notes).toEqual(['a', 'b'])
    expect('answer' in (m ?? {})).toBe(false)
  })

  it('texto parcial (final: false) nunca é espelhado, nem como comentário nem como resposta', () => {
    const msgs = [
      user('u1'),
      text('t1', 'Completo.'),
      text('t2', 'Escrevendo ainda', { final: false }),
      text('t3', 'Resposta parcial', { final: false, answer: true })
    ]
    const m = mirrorTurn(msgs, 'u1', true)
    expect(m?.notes).toEqual(['Completo.'])
    expect(m?.answer).toBeUndefined()
    // A marca answer só existe quando o result chegou: o turno acabou, mesmo sem texto a espelhar.
    expect(m?.done).toBe(true)
  })

  it('o texto parcial vira comentário quando completa (mesmo id, final: true)', () => {
    const partial = [user('u1'), text('t1', 'Vou procurar', { final: false })]
    expect(mirrorTurn(partial, 'u1', true)?.notes).toEqual([])
    const complete = [user('u1'), text('t1', 'Vou procurar o filtro.', { final: true })]
    expect(mirrorTurn(complete, 'u1', true)?.notes).toEqual(['Vou procurar o filtro.'])
  })

  it('texto vazio ou só espaço é pulado; os outros saem aparados', () => {
    const msgs = [user('u1'), text('t1', ''), text('t2', '  \n '), text('t3', '  Achei.\n'), text('t4', '\n\nPronto.\n', { answer: true })]
    const m = mirrorTurn(msgs, 'u1', false)
    expect(m?.notes).toEqual(['Achei.'])
    expect(m?.answer).toBe('Pronto.')
  })

  it('a resposta marcada mas vazia não vira resposta', () => {
    const m = mirrorTurn([user('u1'), text('t1', 'Achei.'), text('t2', ' ', { answer: true })], 'u1', false)
    expect(m?.notes).toEqual(['Achei.'])
    expect(m?.answer).toBeUndefined()
  })

  it('várias respostas no turno (resultado depois de ajuste): a última é a resposta; as anteriores são comentários, em ordem', () => {
    const msgs = [
      user('u1'),
      text('t1', 'a'),
      text('t2', 'resposta 1', { answer: true }),
      text('t3', 'b'),
      text('t4', 'resposta 2', { answer: true })
    ]
    const m = mirrorTurn(msgs, 'u1', false)
    expect(m?.notes).toEqual(['a', 'resposta 1', 'b'])
    expect(m?.answer).toBe('resposta 2')
  })

  it('pensamentos, status e erros não viram comentário', () => {
    const msgs: UIMessage[] = [
      user('u1'),
      thinking('th1'),
      { kind: 'status', id: 's1', text: 'compactando' },
      { kind: 'error', id: 'e1', text: 'falhou a conexão' },
      text('t1', 'Só este.')
    ]
    expect(mirrorTurn(msgs, 'u1', true)?.notes).toEqual(['Só este.'])
  })
})

describe('mirrorTurn — as ações do turno (tools)', () => {
  it('só tool-uses da trilha principal; o de subagente nunca entra, nem na atividade', () => {
    const own = read('k1', 'a.ts', OK)
    const sub = tool('k2', 'Edit', { file_path: 'b.ts', new_string: 'x' }, { parent: 'toolu_agent', result: OK })
    const legacy = { kind: 'tool-use', id: 'k3', name: 'Read', input: { file_path: 'c.ts' } } as unknown as UIMessage // dado antigo, sem parentToolUseId
    const m = mirrorTurn([user('u1'), own, sub, legacy], 'u1', false)
    expect(m?.tools).toEqual([own, legacy])
    expect(m?.activity.count).toBe(2)
    expect(m?.activity.text).toBe('Leu 2 arquivos')
    expect(turnToolUses([user('u1'), own, sub, legacy], 'u1')).toEqual([own, legacy])
  })

  it('devolve as próprias mensagens (os cartões do chat), com o resultado já colado', () => {
    const k1 = read('k1', 'a.ts', OK)
    const m = mirrorTurn([user('u1'), k1], 'u1', false)
    expect(m?.tools[0]).toBe(k1)
  })

  it('a atividade usa só as ações do turno — nem o anterior nem o seguinte', () => {
    const msgs = [
      user('u0'),
      read('k0', 'anterior.ts', OK),
      text('t0', 'ok', { answer: true }),
      user('u1'),
      tool('k1', 'Edit', { file_path: 'C:\\proj\\filtros.js', old_string: 'a', new_string: 'b\nc' }, { result: OK }),
      text('t1', 'Feito.', { answer: true }),
      user('u2'),
      tool('k2', 'Bash', { command: 'npm test' }, { result: OK })
    ]
    const m = mirrorTurn(msgs, 'u1', false)
    expect(m?.activity.text).toBe('Editou filtros.js +2 −1')
    expect(m?.activity.count).toBe(1)
    expect(mirrorTurn(msgs, 'u2', false)?.activity.text).toBe('Rodou os testes ✓')
    expect(mirrorTurn(msgs, 'u0', false)?.activity.text).toBe('Leu anterior.ts')
  })

  it('erro de uma ação aparece na atividade', () => {
    const m = mirrorTurn([user('u1'), tool('k1', 'Bash', { command: 'npm test' }, { result: { isError: true, text: 'falhou' } })], 'u1', false)
    expect(m?.activity).toMatchObject({ text: 'Rodou os testes ✗ · 1 erro', count: 1, errors: 1 })
  })
})

describe('mirrorTurn — done', () => {
  it('rodando, sem resposta e sem user depois: o turno não acabou', () => {
    expect(mirrorTurn([user('u1'), text('t1', 'a'), read('k1', 'a.ts', OK)], 'u1', true)?.done).toBe(false)
  })

  it('answer: true no turno marca done, mesmo com o destino ainda dado como rodando (é a marca que o result deixa)', () => {
    expect(mirrorTurn([user('u1'), text('t1', 'Pronto.', { answer: true })], 'u1', true)?.done).toBe(true)
  })

  it('destino parado (running: false) com a âncora presente: acabou, mesmo sem resposta (turno sem texto, interrompido, falhou)', () => {
    expect(mirrorTurn([user('u1'), read('k1', 'a.ts', OK)], 'u1', false)?.done).toBe(true)
    expect(mirrorTurn([user('u1')], 'u1', false)).toMatchObject({ done: true, started: false })
  })

  it('a resposta do turno anterior não fecha o atual (o reducer marca a última assistant-text da conversa toda)', () => {
    const msgs = [user('u0'), text('t0', 'Feito.', { answer: true }), user('u1'), tool('k1', 'Read', { file_path: 'a.ts' })]
    expect(mirrorTurn(msgs, 'u1', true)?.done).toBe(false)
    expect(mirrorTurn(msgs, 'u0', true)?.done).toBe(true)
  })

  it('uma user injetada NÃO fecha o turno: o que vem depois continua dele', () => {
    const msgs = [
      user('u1'),
      text('t1', 'Vou ver.'),
      user('u2', true),
      read('k1', 'a.ts', OK),
      text('t2', 'Ajustado.')
    ]
    const m = mirrorTurn(msgs, 'u1', true)
    expect(m?.done).toBe(false)
    expect(m?.notes).toEqual(['Vou ver.', 'Ajustado.'])
    expect(m?.tools).toHaveLength(1)
    expect(turnToolUses(msgs, 'u1')).toHaveLength(1)
  })

  it('uma user normal depois fecha o turno (done) e o que vem depois dela não conta', () => {
    const msgs = [user('u1'), text('t1', 'Vou ver.'), user('u2'), text('t2', 'Outro turno.'), read('k2', 'x.ts', OK)]
    const m = mirrorTurn(msgs, 'u1', true)
    expect(m?.done).toBe(true)
    expect(m?.notes).toEqual(['Vou ver.'])
    expect(m?.tools).toEqual([])
    expect(mirrorTurn(msgs, 'u2', true)).toMatchObject({ done: false, notes: ['Outro turno.'] })
  })

  it('o turno fechado pela user seguinte não fica "rodando", mesmo com running: true', () => {
    const msgs = [user('u1'), tool('k1', 'Read', { file_path: 'a.ts' }), user('u2')]
    const m = mirrorTurn(msgs, 'u1', true)
    expect(m?.done).toBe(true)
    expect(m?.activity.now).toBeUndefined()
    expect(m?.activity.text).toBe('Leu a.ts')
  })
})

describe('mirrorTurn — o "agora" da atividade', () => {
  const running = [user('u1'), read('k1', 'a.ts', OK), tool('k2', 'Read', { file_path: 'C:\\proj\\auth.ts' })]

  it('rodando e sem resultado na última ação: "agora" vem dela e ela não entra no resumo', () => {
    const m = mirrorTurn(running, 'u1', true)
    expect(m?.done).toBe(false)
    expect(m?.activity.now).toBe('lendo auth.ts…')
    expect(m?.activity.text).toBe('Leu a.ts')
    expect(m?.activity.count).toBe(2)
  })

  it('parado (running: false): sem "agora"', () => {
    const m = mirrorTurn(running, 'u1', false)
    expect(m?.activity.now).toBeUndefined()
    expect(m?.activity.text).toBe('Leu 2 arquivos')
  })

  it('turno terminado (done) não tem "agora", mesmo que o chamador ainda diga running: true', () => {
    const m = mirrorTurn([...running, text('t1', 'Pronto.', { answer: true })], 'u1', true)
    expect(m?.done).toBe(true)
    expect(m?.activity.now).toBeUndefined()
  })
})

describe('turnToolUses', () => {
  it('é a mesma lista de tools do espelho (para a vista que abre ao clique)', () => {
    const msgs = [user('u1'), read('k1', 'a.ts', OK), text('t1', 'x'), tool('k2', 'Bash', { command: 'ls' }, { result: OK }), user('u2'), read('k3', 'z.ts', OK)]
    // O contrato devolve UIMessage[] (nem toda variante tem `id`): o teste estreita antes de ler.
    const ids = (list: UIMessage[]): string[] => list.map((m) => ('id' in m ? m.id : ''))
    expect(turnToolUses(msgs, 'u1')).toEqual(mirrorTurn(msgs, 'u1', false)?.tools)
    expect(ids(turnToolUses(msgs, 'u1'))).toEqual(['k1', 'k2'])
    expect(ids(turnToolUses(msgs, 'u2'))).toEqual(['k3'])
  })

  it('âncora ausente: lista vazia (nunca null)', () => {
    expect(turnToolUses([user('u1'), read('k1', 'a.ts')], 'nao-existe')).toEqual([])
  })
})
