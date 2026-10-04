// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  EMIT_INTERVAL_MS,
  ToolInputStreams,
  extractClosedString,
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

describe('extractClosedString', () => {
  it('só devolve o valor depois que a aspa de fechamento chegou', () => {
    expect(extractClosedString('{"file_path":"/a/b', 'file_path')).toBeUndefined()
    expect(extractClosedString('{"file_path":"/a/b.ts"', 'file_path')).toBe('/a/b.ts')
    expect(extractClosedString('{"file_path":"/a/b.ts","content":"x', 'file_path')).toBe('/a/b.ts')
    // Aspa de abertura sem nada dentro ainda é string aberta; "" fechada é um valor vazio.
    expect(extractClosedString('{"file_path":"', 'file_path')).toBeUndefined()
    expect(extractClosedString('{"file_path":""', 'file_path')).toBe('')
  })

  it('um escape no fim do pedaço não fecha a string: \\", \\\\ e \\u00e', () => {
    // No fio, na ordem: diz \"  |  c:\\  |  c:\  |  caf\u00e  |  caf\u00e9
    expect(extractClosedString('{"old_string":"diz \\"', 'old_string')).toBeUndefined()
    expect(extractClosedString('{"old_string":"c:\\\\', 'old_string')).toBeUndefined()
    expect(extractClosedString('{"old_string":"c:\\', 'old_string')).toBeUndefined()
    expect(extractClosedString('{"old_string":"caf\\u00e', 'old_string')).toBeUndefined()
    expect(extractClosedString('{"old_string":"caf\\u00e9', 'old_string')).toBeUndefined()
    // O que fecha é a aspa SEGUINTE ao escape.
    expect(extractClosedString('{"old_string":"diz \\""', 'old_string')).toBe('diz "')
    expect(extractClosedString('{"old_string":"c:\\\\"', 'old_string')).toBe('c:\\')
    expect(extractClosedString('{"old_string":"caf\\u00e9"', 'old_string')).toBe('café')
  })

  it('mesmas regras de chave de extractPartialString: nível superior e valor string', () => {
    expect(extractClosedString('{"meta":{"file_path":"aninhado"},"x":1}', 'file_path')).toBeUndefined()
    expect(extractClosedString('{"old_string":"\\"file_path\\":\\"falso\\"","file_path":"/real"}', 'file_path')).toBe('/real')
    expect(extractClosedString('{"file_path":12}', 'file_path')).toBeUndefined()
    expect(extractClosedString('{"file_path":', 'file_path')).toBeUndefined()
    expect(extractClosedString('', 'file_path')).toBeUndefined()
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

/** O JSON como o `input_json_delta` o acumula: ASCII puro, o resto como `\uXXXX`
 *  (o emoji vira o par substituto), para o corte poder cair em qualquer escape. */
const wire = (value: unknown): string =>
  JSON.stringify(value).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
/** Índice logo depois da aspa que fecha, em `json`, o valor string `value`. */
const closesAt = (json: string, value: string): number => json.indexOf(wire(value)) + wire(value).length

const WIN_PATH = 'C:\\proj\\loja\\src\\c.ts'
/** Aspas, barra, quebra de linha, tab, acento e emoji: um de cada tipo de escape. */
const OLD = 'diz "oi"\nC:\\tmp\\x é 😀'
const NEW = 'novo "tchau"\n\tC:\\y ü 😀 fim'

describe('toolInputFields — string aberta não vira campo, em todo ponto de corte', () => {
  it('Edit: filePath e oldText só aparecem fechados; newText nunca passa do real nem encolhe', () => {
    const full = wire({ file_path: WIN_PATH, old_string: OLD, new_string: NEW })
    const pathEnd = closesAt(full, WIN_PATH)
    const oldEnd = closesAt(full, OLD)
    let seen = 0
    for (let n = 0; n <= full.length; n++) {
      const at = `corte em ${n}: ${full.slice(0, n)}`
      const got = toolInputFields('Edit', full.slice(0, n))
      expect(got.filePath, at).toBe(n >= pathEnd ? WIN_PATH : undefined)
      expect(got.oldText, at).toBe(n >= oldEnd ? OLD : undefined)
      expect(NEW.startsWith(got.newText ?? ''), at).toBe(true)
      expect((got.newText ?? '').length, at).toBeGreaterThanOrEqual(seen)
      seen = (got.newText ?? '').length
    }
    // Falta só a aspa de fechamento: o texto todo já está lá (segue parcial, ao vivo).
    expect(toolInputFields('Edit', full.slice(0, closesAt(full, NEW) - 1)).newText).toBe(NEW)
  })

  it('MultiEdit: vale só o item atual, e o oldText dele só aparece fechado (nunca o do anterior)', () => {
    const edits = [
      { old_string: 'o1 "a"', new_string: 'n1' },
      { old_string: OLD, new_string: NEW }
    ]
    // file_path antes e depois do array: a posição da chave não muda a regra.
    for (const input of [{ file_path: WIN_PATH, edits }, { edits, file_path: WIN_PATH }]) {
      const full = wire(input)
      const pathEnd = closesAt(full, WIN_PATH)
      const itemAt = [full.indexOf('{', full.indexOf('[')), full.indexOf('},{') + 2]
      const oldEnd = edits.map((e) => closesAt(full, e.old_string))
      for (let n = 0; n <= full.length; n++) {
        const at = `corte em ${n}: ${full.slice(0, n)}`
        const got = toolInputFields('MultiEdit', full.slice(0, n))
        // Item atual = o último cujo `{` já chegou.
        const cur = itemAt.filter((i) => n > i).length - 1
        expect(got.filePath, at).toBe(n >= pathEnd ? WIN_PATH : undefined)
        expect(got.oldText, at).toBe(cur >= 0 && n >= oldEnd[cur] ? edits[cur].old_string : undefined)
        if (cur < 0) expect(got.newText, at).toBeUndefined()
        else expect(edits[cur].new_string.startsWith(got.newText ?? ''), at).toBe(true)
      }
    }
  })

  it('Write e NotebookEdit: o caminho só aparece fechado; o corpo segue parcial', () => {
    const cases = [
      ['Write', { file_path: WIN_PATH, content: NEW }],
      ['NotebookEdit', { notebook_path: WIN_PATH, cell_id: 'c1', new_source: NEW }]
    ] as const
    for (const [name, input] of cases) {
      const full = wire(input)
      const pathEnd = closesAt(full, WIN_PATH)
      for (let n = 0; n <= full.length; n++) {
        const at = `${name}, corte em ${n}: ${full.slice(0, n)}`
        const got = toolInputFields(name, full.slice(0, n))
        expect(got.filePath, at).toBe(n >= pathEnd ? WIN_PATH : undefined)
        expect(got.oldText, at).toBeUndefined()
        expect(NEW.startsWith(got.newText ?? ''), at).toBe(true)
      }
      expect(toolInputFields(name, full)).toEqual({ filePath: WIN_PATH, newText: NEW })
    }
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

  it('Edit: o caminho cortado não vira filePath (a aba "c") e o old_string só vem inteiro', () => {
    const { streams, out, clock } = harness()
    const chunks = [
      '{"file_path":"C:\\\\proj\\\\loja\\\\src\\\\c', // caminho ainda aberto: ...\src\c
      '.ts","old_string":"linha um\\nlin', // caminho fechou; old_string aberto, new_string nem começou
      'ha dois","new_string":"nov', // old_string fechou; new_string (ao vivo) aberto
      'o"}'
    ]
    streams.handle(start(0, 'e1', 'Edit'))
    for (const chunk of chunks) {
      streams.handle(delta(0, chunk))
      clock.t += EMIT_INTERVAL_MS
    }
    streams.handle(stop(0))
    const path = 'C:\\proj\\loja\\src\\c.ts'
    const ev = { kind: 'tool-input-delta', toolUseId: 'e1', name: 'Edit', done: false }
    const closed = { filePath: path, oldText: 'linha um\nlinha dois' }
    // toStrictEqual: a chave ausente não pode virar `undefined`.
    expect(out).toStrictEqual([
      { ...ev, newText: '', totalLines: 0 }, // sem filePath: era aqui que nascia a aba "c"
      { ...ev, filePath: path, newText: '', totalLines: 0 }, // sem oldText
      { ...ev, ...closed, newText: 'nov', totalLines: 1 },
      { ...ev, ...closed, newText: 'novo', totalLines: 1 },
      { ...ev, ...closed, newText: 'novo', totalLines: 1, done: true }
    ])
  })

  it('MultiEdit: o item atual cortado não herda o oldText do anterior; fechado, vem inteiro', () => {
    const { streams, out, clock } = harness()
    const chunks = [
      '{"file_path":"/p/a.ts","edits":[{"old_string":"o1', // 1º item, old_string aberto
      '","new_string":"n1"},{"old_string":"o2 par', // o 1º fechou; o 2º abriu com old_string aberto
      'cial","new_string":"n2', // old_string do 2º fechou
      '"}]}'
    ]
    streams.handle(start(0, 'm1', 'MultiEdit'))
    for (const chunk of chunks) {
      streams.handle(delta(0, chunk))
      clock.t += EMIT_INTERVAL_MS
    }
    const ev = { kind: 'tool-input-delta', toolUseId: 'm1', name: 'MultiEdit', filePath: '/p/a.ts', done: false }
    expect(out).toStrictEqual([
      { ...ev, newText: '', totalLines: 0 },
      { ...ev, newText: '', totalLines: 0 },
      { ...ev, oldText: 'o2 parcial', newText: 'n2', totalLines: 1 },
      { ...ev, oldText: 'o2 parcial', newText: 'n2', totalLines: 1 }
    ])
  })

  it('Write e NotebookEdit: sem filePath no evento enquanto o caminho está aberto', () => {
    for (const [name, pathKey, bodyKey] of [
      ['Write', 'file_path', 'content'],
      ['NotebookEdit', 'notebook_path', 'new_source']
    ] as const) {
      const { streams, out, clock } = harness()
      streams.handle(start(0, 'w1', name))
      streams.handle(delta(0, `{"${pathKey}":"C:\\\\proj\\\\c`))
      clock.t += EMIT_INTERVAL_MS
      streams.handle(delta(0, `.ts","${bodyKey}":"x = 1\\ny`))
      const ev = { kind: 'tool-input-delta', toolUseId: 'w1', name, done: false }
      expect(out).toStrictEqual([
        { ...ev, newText: '', totalLines: 0 },
        { ...ev, filePath: 'C:\\proj\\c.ts', newText: 'x = 1\ny', totalLines: 2 }
      ])
    }
  })

  it('oldText fechado traz a cauda de 40 linhas; aberto, nada — mesmo já passando de 40 linhas', () => {
    const { streams, out, clock } = harness()
    const old = Array.from({ length: 100 }, (_, i) => `l${i + 1}`).join('\\n')
    streams.handle(start(0, 'e1', 'Edit'))
    streams.handle(delta(0, `{"file_path":"/a.ts","old_string":"${old}`))
    expect(out).toHaveLength(1)
    expect('oldText' in out[0]).toBe(false)
    clock.t += EMIT_INTERVAL_MS
    streams.handle(delta(0, '","new_string":"x"}'))
    const tail = out[1].oldText!.split('\n')
    expect(tail).toHaveLength(40)
    expect([tail[0], tail[39]]).toEqual(['l61', 'l100'])
  })

  it('old_string "" fechado vai como oldText vazio; só a aspa de abertura é ausente (vazio ≠ ausente)', () => {
    const { streams, out, clock } = harness()
    streams.handle(start(0, 'e1', 'Edit'))
    streams.handle(delta(0, '{"file_path":"/novo.ts","old_string":"'))
    expect('oldText' in out[0]).toBe(false)
    clock.t += EMIT_INTERVAL_MS
    streams.handle(delta(0, '","new_string":"x'))
    expect(out[1]).toMatchObject({ filePath: '/novo.ts', oldText: '', newText: 'x' })
  })

  it('stream cortado no meio do caminho: o done não inventa filePath', () => {
    const { streams, out } = harness()
    streams.handle(start(0, 'e1', 'Edit'))
    streams.handle(delta(0, '{"file_path":"C:\\\\proj\\\\loja\\\\src\\\\c'))
    streams.finishAll()
    expect(out.at(-1)).toStrictEqual({ kind: 'tool-input-delta', toolUseId: 'e1', name: 'Edit', newText: '', totalLines: 0, done: true })
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
