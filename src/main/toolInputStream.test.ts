// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  EMIT_INTERVAL_MS,
  ToolInputStreams,
  extractPartialString,
  tailLines,
  toolInputFields,
  type RawStreamEvent,
  type ToolInputDelta
} from './toolInputStream'

describe('extractPartialString', () => {
  it('lê o valor incompleto de uma chave de nível superior', () => {
    expect(extractPartialString('{"file_path":"/a.ts","content":"linha 1\\nlin', 'content')).toBe('linha 1\nlin')
    expect(extractPartialString('{"file_path":"/a.ts","content":"tudo"}', 'content')).toBe('tudo')
    expect(extractPartialString(' { "content" : "com espaços', 'content')).toBe('com espaços')
  })

  it('decodifica os escapes \\n \\t \\" \\\\ \\/ e \\uXXXX', () => {
    const json = '{"content":"a\\nb\\tc\\"d\\\\e\\/f\\u00e9g\\ud83d\\ude00h"}'
    expect(extractPartialString(json, 'content')).toBe('a\nb\tc"d\\e/fég😀h')
  })

  it('deixa de fora um escape cortado no fim, sem inventar caractere', () => {
    expect(extractPartialString('{"content":"abc\\', 'content')).toBe('abc')
    expect(extractPartialString('{"content":"abc\\u00', 'content')).toBe('abc')
    expect(extractPartialString('{"content":"abc\\u00e', 'content')).toBe('abc')
    // A 1ª metade de um par substituto espera a 2ª.
    expect(extractPartialString('{"content":"x\\ud83d', 'content')).toBe('x')
    expect(extractPartialString('{"content":"x\\ud83d\\ude', 'content')).toBe('x')
    expect(extractPartialString('{"content":"x\\ud83d\\ude00', 'content')).toBe('x😀')
  })

  it('devolve undefined enquanto a chave não apareceu inteira', () => {
    expect(extractPartialString('', 'content')).toBeUndefined()
    expect(extractPartialString('{"file_path":"/a.ts"', 'content')).toBeUndefined()
    expect(extractPartialString('{"file_path":"/a.ts","cont', 'content')).toBeUndefined()
    expect(extractPartialString('{"content"', 'content')).toBeUndefined()
    // A chave chegou, mas o valor ainda não começou como string.
    expect(extractPartialString('{"content":', 'content')).toBeUndefined()
    expect(extractPartialString('{"content":12}', 'content')).toBeUndefined()
  })

  it('ignora a mesma chave aninhada ou escrita dentro de outra string', () => {
    expect(extractPartialString('{"meta":{"content":"aninhado"},"x":1}', 'content')).toBeUndefined()
    expect(extractPartialString('{"list":[{"content":"no array"}]}', 'content')).toBeUndefined()
    expect(extractPartialString('{"old_string":"\\"content\\":\\"falso\\"","content":"real', 'content')).toBe('real')
    expect(extractPartialString('{"old_string":"{\\"content\\":\\"falso', 'content')).toBeUndefined()
    // Valor com chaves e colchetes dentro da string não mexe na profundidade.
    expect(extractPartialString('{"a":"{[}]","content":"ok"}', 'content')).toBe('ok')
  })

  it('não trata como chave uma string na posição de valor', () => {
    expect(extractPartialString('{"a":"content","b":"x"}', 'content')).toBeUndefined()
  })

  it('não lê nada fora de um objeto', () => {
    expect(extractPartialString('["content","x"]', 'content')).toBeUndefined()
  })
})

describe('toolInputFields', () => {
  it('Write: file_path e content', () => {
    expect(toolInputFields('Write', '{"file_path":"/p/a.ts","content":"x = 1\\n')).toEqual({
      filePath: '/p/a.ts',
      newText: 'x = 1\n'
    })
  })

  it('Edit: old_string e new_string', () => {
    expect(toolInputFields('Edit', '{"file_path":"/p/a.ts","old_string":"antes","new_string":"dep')).toEqual({
      filePath: '/p/a.ts',
      oldText: 'antes',
      newText: 'dep'
    })
  })

  it('MultiEdit: o old/new do ÚLTIMO item de edits, sem pegar os de nível superior', () => {
    const json =
      '{"file_path":"/p/a.ts","edits":[{"old_string":"o1","new_string":"n1"},{"old_string":"o2","new_string":"n2 parc'
    expect(toolInputFields('MultiEdit', json)).toEqual({ filePath: '/p/a.ts', oldText: 'o2', newText: 'n2 parc' })
    // O 2º item acabou de abrir: ainda não tem new_string.
    expect(toolInputFields('MultiEdit', '{"file_path":"/p","edits":[{"old_string":"o1","new_string":"n1"},{"old_')).toEqual({
      filePath: '/p',
      oldText: undefined,
      newText: undefined
    })
    // file_path depois do array também é lido.
    expect(toolInputFields('MultiEdit', '{"edits":[{"old_string":"o","new_string":"n"}],"file_path":"/z"}')).toEqual({
      filePath: '/z',
      oldText: 'o',
      newText: 'n'
    })
  })

  it('NotebookEdit: notebook_path e new_source', () => {
    expect(toolInputFields('NotebookEdit', '{"notebook_path":"/n.ipynb","cell_id":"c1","new_source":"print(1')).toEqual({
      filePath: '/n.ipynb',
      newText: 'print(1'
    })
  })
})

describe('tailLines', () => {
  it('conta as linhas e corta nas últimas n', () => {
    expect(tailLines('')).toEqual({ text: '', totalLines: 0 })
    expect(tailLines('a')).toEqual({ text: 'a', totalLines: 1 })
    expect(tailLines('a\nb\nc', 2)).toEqual({ text: 'b\nc', totalLines: 3 })
    const big = Array.from({ length: 100 }, (_, i) => `linha ${i + 1}`).join('\n')
    const cut = tailLines(big)
    expect(cut.totalLines).toBe(100)
    expect(cut.text.split('\n')).toHaveLength(40)
    expect(cut.text.startsWith('linha 61\n')).toBe(true)
    expect(cut.text.endsWith('linha 100')).toBe(true)
  })
})

/** Monta a sessão de teste: relógio manual e os eventos emitidos. */
function harness(): { streams: ToolInputStreams; out: ToolInputDelta[]; clock: { t: number } } {
  const out: ToolInputDelta[] = []
  const clock = { t: 1_000 }
  return { streams: new ToolInputStreams((e) => out.push(e), () => clock.t), out, clock }
}

const start = (index: number, id: string, name: string): RawStreamEvent => ({
  type: 'content_block_start',
  index,
  content_block: { type: 'tool_use', id, name }
})
const delta = (index: number, partial: string): RawStreamEvent => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'input_json_delta', partial_json: partial }
})
const stop = (index: number): RawStreamEvent => ({ type: 'content_block_stop', index })

describe('ToolInputStreams', () => {
  it('emite no máximo uma vez por intervalo por bloco e sempre o estado final no stop', () => {
    const { streams, out, clock } = harness()
    streams.handle({ type: 'message_start' })
    streams.handle(start(1, 'tu1', 'Write'))
    streams.handle(delta(1, '{"file_path":"/a.ts","content":"a'))
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      kind: 'tool-input-delta',
      toolUseId: 'tu1',
      name: 'Write',
      filePath: '/a.ts',
      newText: 'a',
      totalLines: 1,
      done: false
    })
    // Dentro do intervalo: só acumula.
    clock.t += EMIT_INTERVAL_MS - 1
    streams.handle(delta(1, '\\nb'))
    streams.handle(delta(1, '\\nc'))
    expect(out).toHaveLength(1)
    clock.t += 1
    streams.handle(delta(1, '\\nd'))
    expect(out).toHaveLength(2)
    expect(out[1]).toMatchObject({ newText: 'a\nb\nc\nd', totalLines: 4, done: false })
    // O stop manda o final mesmo dentro do intervalo.
    streams.handle(delta(1, '"}'))
    streams.handle(stop(1))
    expect(out).toHaveLength(3)
    expect(out[2]).toMatchObject({ newText: 'a\nb\nc\nd', done: true })
  })

  it('deltas a cada 17 ms (o ritmo medido) saem com pelo menos 100 ms entre emissões: ≤ 10 por segundo', () => {
    const clock = { t: 0 }
    const at: number[] = []
    const streams = new ToolInputStreams(() => at.push(clock.t), () => clock.t)
    streams.handle(start(0, 'tu', 'Write'))
    streams.handle(delta(0, '{"content":"'))
    for (let i = 0; i < 200; i++) {
      clock.t += 17
      streams.handle(delta(0, 'x'))
    }
    const gaps = at.slice(1).map((t, i) => t - at[i])
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(EMIT_INTERVAL_MS)
    // 3,4 s de deltas: nunca mais que 10 numa janela de 1 s.
    for (const t0 of at) expect(at.filter((t) => t >= t0 && t < t0 + 1000).length).toBeLessThanOrEqual(10)
    expect(at.length).toBeGreaterThan(20)
  })

  it('corta nas últimas 40 linhas e informa o total', () => {
    const { streams, out } = harness()
    const body = Array.from({ length: 161 }, (_, i) => `l${i + 1}`).join('\\n')
    streams.handle(start(0, 'tu', 'Write'))
    streams.handle(delta(0, `{"file_path":"/big.ts","content":"${body}"}`))
    streams.handle(stop(0))
    const last = out.at(-1)!
    expect(last.totalLines).toBe(161)
    expect(last.newText.split('\n')).toHaveLength(40)
    expect(last.newText.startsWith('l122\n')).toBe(true)
  })

  it('Edit leva oldText e newText', () => {
    const { streams, out } = harness()
    streams.handle(start(2, 'e1', 'Edit'))
    streams.handle(delta(2, '{"file_path":"/a.ts","old_string":"velho","new_string":"novo"}'))
    streams.handle(stop(2))
    expect(out.at(-1)).toMatchObject({ toolUseId: 'e1', name: 'Edit', oldText: 'velho', newText: 'novo', done: true })
  })

  it('ignora outras ferramentas, blocos de texto e deltas de outro tipo', () => {
    const { streams, out } = harness()
    streams.handle(start(0, 'r1', 'Read'))
    streams.handle(delta(0, '{"file_path":"/a.ts"}'))
    streams.handle(stop(0))
    streams.handle({ type: 'content_block_start', index: 1, content_block: { type: 'text' } })
    streams.handle({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'oi' } })
    streams.handle(stop(1))
    streams.handle(start(2, 'm1', 'mcp__x__Write'))
    streams.handle(delta(2, '{"content":"x"}'))
    expect(out).toEqual([])
  })

  it('a chave é (mensagem corrente, index): o mesmo index na mensagem seguinte é outro bloco', () => {
    const { streams, out, clock } = harness()
    streams.handle({ type: 'message_start' })
    streams.handle(start(1, 'w1', 'Write'))
    streams.handle(delta(1, '{"content":"primeiro'))
    // Mensagem nova sem o stop da anterior (stream cortado): o bloco velho fecha.
    streams.handle({ type: 'message_start' })
    expect(out.at(-1)).toMatchObject({ toolUseId: 'w1', newText: 'primeiro', done: true })
    clock.t += 1
    streams.handle(start(1, 'w2', 'Write'))
    streams.handle(delta(1, '{"content":"segundo'))
    expect(out.at(-1)).toMatchObject({ toolUseId: 'w2', newText: 'segundo', done: false })
    // Delta de um index que não abriu bloco nenhum não vaza para outro.
    streams.handle(delta(0, '{"content":"órfão"}'))
    expect(out.filter((e) => e.newText.includes('órfão'))).toEqual([])
  })

  it('finishAll fecha com done os blocos abertos e não repete', () => {
    const { streams, out } = harness()
    streams.handle(start(0, 'a', 'Write'))
    streams.handle(start(1, 'b', 'Edit'))
    streams.handle(delta(0, '{"content":"x'))
    streams.finishAll()
    expect(out.filter((e) => e.done).map((e) => e.toolUseId).sort()).toEqual(['a', 'b'])
    const n = out.length
    streams.finishAll()
    streams.handle(stop(0))
    expect(out).toHaveLength(n)
  })
})
