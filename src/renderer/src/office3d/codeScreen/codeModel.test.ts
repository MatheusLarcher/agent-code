import { describe, expect, it } from 'vitest'
import { trackMessages } from '../chatPage'
import { track } from '../../office/adapter/testFeed'
import type { UIMessage } from '../../types'
import { buildTabs, buildTerminal, MAX_TABS, SCAN_MAX } from './codeModel'

const P = 'C:\\proj\\loja\\src\\'
let seq = 0
const user = (): UIMessage => ({ kind: 'user', id: `u${seq++}`, text: 'pedido' })
const tool = (name: string, input: unknown, result?: string | false, isError = false): UIMessage => ({
  kind: 'tool-use',
  id: `t${seq++}`,
  name,
  input,
  parentToolUseId: null,
  ...(result === false || result === undefined ? {} : { result: { isError, text: result } })
})
const write = (file: string, content: string, result: string | false = 'File created successfully at: x'): UIMessage =>
  tool('Write', { file_path: P + file, content }, result)
const edit = (file: string, old: string, neu: string, result: string | false = 'The file x has been updated.'): UIMessage =>
  tool('Edit', { file_path: P + file, old_string: old, new_string: neu }, result)

describe('buildTabs', () => {
  it('um arquivo por aba, do mais recente ao mais antigo; Read e erro não contam', () => {
    const msgs = [
      user(),
      write('a.ts', 'a'),
      tool('Read', { file_path: P + 'z.ts' }, 'conteúdo'),
      edit('b.ts', 'x', 'y'),
      edit('c.ts', 'x', 'y', 'String to replace not found', ),
      tool('Edit', { file_path: P + 'd.ts', old_string: 'x', new_string: 'y' }, 'falhou', true),
      edit('a.ts', 'a', 'A')
    ]
    expect(buildTabs(msgs).map((t) => t.name)).toEqual(['a.ts', 'c.ts', 'b.ts'])
  })

  it(`no máximo ${MAX_TABS} abas e no máximo ${SCAN_MAX} mensagens lidas do fim`, () => {
    const many = [user(), ...Array.from({ length: 15 }, (_, i) => write(`f${i}.ts`, String(i)))]
    const tabs = buildTabs(many)
    expect(tabs).toHaveLength(MAX_TABS)
    expect(tabs[0].name).toBe('f14.ts')
    const old = [user(), write('velho.ts', 'v'), ...Array.from({ length: SCAN_MAX }, () => tool('Read', { file_path: 'x' }, 'ok'))]
    expect(buildTabs(old)).toHaveLength(0)
  })

  it('as edições da aba são as do ÚLTIMO turno que mexeu no arquivo', () => {
    const msgs = [user(), edit('a.ts', '1', '2'), user(), edit('b.ts', 'x', 'y'), edit('a.ts', '2', '3'), edit('a.ts', '3', '4'), user(), edit('b.ts', 'y', 'z')]
    const [b, a] = buildTabs(msgs)
    expect(b.edits.map((e) => (e.kind === 'edit' ? e.new : ''))).toEqual(['z'])
    expect(a.edits.map((e) => (e.kind === 'edit' ? e.new : ''))).toEqual(['3', '4'])
  })

  it('U quando um Write criou o arquivo (o resultado diz "created"); M nos outros', () => {
    const msgs = [user(), write('novo.ts', 'n'), write('velho.ts', 'v', 'The file x has been updated.'), edit('outro.ts', 'a', 'b')]
    expect(Object.fromEntries(buildTabs(msgs).map((t) => [t.name, t.status]))).toEqual({ 'outro.ts': 'M', 'velho.ts': 'M', 'novo.ts': 'U' })
  })

  it('o conteúdo de antes do turno: criado no turno = vazio; Write anterior + edições depois dele; senão desconhecido', () => {
    const msgs = [
      user(),
      write('a.ts', 'linha 1\nlinha 2'),
      edit('a.ts', 'linha 2', 'linha dois'),
      edit('b.ts', 'x', 'y'),
      user(),
      write('a.ts', 'tudo novo', 'The file x has been updated.'),
      edit('b.ts', 'y', 'z'),
      write('c.ts', 'c')
    ]
    const tabs = Object.fromEntries(buildTabs(msgs).map((t) => [t.name, t]))
    expect(tabs['a.ts'].base).toBe('linha 1\nlinha dois')
    expect(tabs['b.ts'].base).toBeNull()
    expect(tabs['c.ts'].base).toBe('')
  })

  it('edição que não se aplica ao conteúdo conhecido (ou pendente num turno velho) deixa a base desconhecida', () => {
    const msgs = [user(), write('a.ts', 'abc'), edit('a.ts', 'nada disso', 'x'), user(), edit('a.ts', 'q', 'w')]
    expect(buildTabs(msgs)[0].base).toBeNull()
    const pend = [user(), write('b.ts', 'abc'), edit('b.ts', 'abc', 'abd', false), user(), edit('b.ts', 'abd', 'abe')]
    expect(buildTabs(pend)[0].base).toBeNull()
  })

  it('MultiEdit vira uma edição por item; NotebookEdit guarda o modo; pendente = sem resultado', () => {
    const msgs = [
      user(),
      tool('MultiEdit', { file_path: P + 'm.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd', replace_all: true }] }, 'ok'),
      tool('NotebookEdit', { notebook_path: P + 'n.ipynb', new_source: 'print(1)', edit_mode: 'insert' }, false)
    ]
    const [n, m] = buildTabs(msgs)
    expect(m.edits).toEqual([
      { kind: 'edit', id: `${msgs[1].id}#0`, tool: msgs[1].id, old: 'a', new: 'b', all: false, pending: false },
      { kind: 'edit', id: `${msgs[1].id}#1`, tool: msgs[1].id, old: 'c', new: 'd', all: true, pending: false }
    ])
    expect(n.edits[0]).toMatchObject({ kind: 'notebook', source: 'print(1)', mode: 'insert', pending: true })
    expect(n.pending).toBe(true)
    expect(m.pending).toBe(false)
  })

  it('subagente: a trilha inteira é um turno só', () => {
    const t = track('x', {
      steps: [
        { id: 's1', name: 'Write', input: { file_path: P + 'a.ts', content: 'um' }, startedAt: 1, endedAt: 2, result: 'File created successfully' },
        { id: 's2', name: 'Edit', input: { file_path: P + 'a.ts', old_string: 'um', new_string: 'dois' }, startedAt: 3 }
      ]
    })
    const [a] = buildTabs(trackMessages(t))
    expect(a.edits.map((e) => e.kind)).toEqual(['write', 'edit'])
    expect(a).toMatchObject({ status: 'U', base: '', pending: true })
  })

  it('a assinatura muda quando o resultado chega', () => {
    const pending = [user(), edit('a.ts', 'x', 'y', false)]
    const done = [pending[0], { ...pending[1], result: { isError: false, text: 'ok' } } as UIMessage]
    expect(buildTabs(pending)[0].sig).not.toBe(buildTabs(done)[0].sig)
    expect(buildTabs(done)[0].doneTools).toEqual([pending[1].id])
  })
})

describe('buildTerminal', () => {
  it('os últimos comandos Bash/PowerShell do turno, com estado e a saída cortada, sem ANSI', () => {
    const long = Array.from({ length: 10 }, (_, i) => `linha ${i}`).join('\n')
    const msgs = [
      user(),
      tool('Bash', { command: 'echo velho' }, 'velho'),
      user(),
      tool('Bash', { command: 'npm test' }, `\u001b[32m✓\u001b[0m 12 testes\n${long}`),
      tool('PowerShell', { command: 'Get-ChildItem' }, 'erro', true),
      tool('Bash', { command: 'npm run build\n--watch' }, false)
    ]
    const term = buildTerminal(msgs)
    expect(term.map((c) => [c.shell, c.command, c.pending, c.ok])).toEqual([
      ['bash', 'npm test', false, true],
      ['pwsh', 'Get-ChildItem', false, false],
      ['bash', 'npm run build\n--watch', true, false]
    ])
    expect(term[0].output).toEqual(['linha 7', 'linha 8', 'linha 9'])
    expect(term[0].more).toBe(8)
    expect(buildTerminal([user(), tool('Bash', { command: 'x' }, '\u001b[1mnegrito\u001b[0m')])[0].output).toEqual(['negrito'])
  })
})
