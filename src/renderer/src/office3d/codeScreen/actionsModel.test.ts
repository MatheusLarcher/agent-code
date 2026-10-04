import { describe, expect, it } from 'vitest'
import { trackMessages, type ToolUseMessage } from '../chatPage'
import type { UIMessage } from '../../types'
import { buildTabs, SCAN_MAX } from './codeModel'
import { buildTurnActions, SUMMARY_MAX, turnStart } from './actionsModel'

const P = 'C:\\proj\\loja\\src\\'
const MEM = 'D:\\OneDrive\\Documentos\\agent-code\\memories'
let seq = 0
const user = (): UIMessage => ({ kind: 'user', id: `u${seq++}`, text: 'pedido' })
const tool = (name: string, input: unknown, result?: string | false, isError = false, parent: string | null = null): ToolUseMessage => ({
  kind: 'tool-use',
  id: `t${seq++}`,
  name,
  input,
  parentToolUseId: parent,
  ...(result === false || result === undefined ? {} : { result: { isError, text: result } })
})
const read = (file: string, extra: Record<string, unknown> = {}, result: string | false = 'conteúdo', isError = false): ToolUseMessage =>
  tool('Read', { file_path: P + file, ...extra }, result, isError)
const edit = (file: string): ToolUseMessage => tool('Edit', { file_path: P + file, old_string: 'a', new_string: 'b' }, 'The file x has been updated.')

describe('turnStart', () => {
  it('a última mensagem do usuário; sem nenhuma, o piso das SCAN_MAX do fim', () => {
    expect(turnStart([])).toBe(0)
    const msgs = [user(), read('a.ts'), user(), read('b.ts')]
    expect(turnStart(msgs)).toBe(2)
    const long = [user(), ...Array.from({ length: SCAN_MAX + 5 }, () => read('x.ts'))]
    expect(turnStart(long)).toBe(long.length - SCAN_MAX)
  })
})

describe('buildTurnActions', () => {
  it('Alterados é exatamente buildTabs (a conversa toda, não só o turno)', () => {
    const msgs = [user(), edit('velho.ts'), user(), edit('novo.ts')]
    const acts = buildTurnActions(msgs)
    expect(acts.changed).toEqual(buildTabs(msgs).map((tab) => ({ ...tab, models: [] })))
    expect(acts.changed.map((t) => t.name)).toEqual(['novo.ts', 'velho.ts'])
  })

  it('Lidos: só o turno atual; turno anterior e subagente ignorados', () => {
    const msgs = [user(), read('antigo.ts'), user(), read('a.ts'), tool('Read', { file_path: P + 'sub.ts' }, 'x', false, 'task-1'), read('b.ts')]
    expect(buildTurnActions(msgs).read.map((r) => r.name)).toEqual(['a.ts', 'b.ts'])
  })

  it('Lidos: repetição deduplicada na posição e com o intervalo da última leitura', () => {
    const msgs = [user(), read('a.ts'), read('b.ts'), read('a.ts', { offset: 40, limit: 20 })]
    const lidos = buildTurnActions(msgs).read
    expect(lidos.map((r) => r.name)).toEqual(['b.ts', 'a.ts'])
    expect(lidos[1]).toMatchObject({ offset: 40, limit: 20, path: P + 'a.ts', key: 'c:/proj/loja/src/a.ts', tool: 'Read' })
    expect(lidos[0]).toMatchObject({ offset: null, limit: null })
  })

  it('Lidos: leitura parcial preserva offset/limit; NotebookRead aceito; sem caminho ignorado', () => {
    const msgs = [
      user(),
      read('parcial.ts', { offset: 10, limit: 5 }),
      tool('NotebookRead', { notebook_path: P + 'nb.ipynb' }, 'cells'),
      tool('Read', {}, 'nada')
    ]
    const lidos = buildTurnActions(msgs).read
    expect(lidos.map((r) => [r.name, r.offset, r.limit, r.tool])).toEqual([
      ['parcial.ts', 10, 5, 'Read'],
      ['nb.ipynb', null, null, 'NotebookRead']
    ])
  })

  it('arquivo lido e depois alterado no mesmo turno aparece só em Alterados', () => {
    const msgs = [user(), read('a.ts'), read('b.ts'), edit('a.ts')]
    const acts = buildTurnActions(msgs)
    expect(acts.changed.map((t) => t.name)).toEqual(['a.ts'])
    expect(acts.read.map((r) => r.name)).toEqual(['b.ts'])
  })

  it('arquivo alterado e relido (caixa/barras diferentes) também fica só em Alterados', () => {
    const msgs = [user(), edit('a.ts'), user(), tool('Read', { file_path: 'c:/PROJ/loja/src/A.ts' }, 'x')]
    expect(buildTurnActions(msgs).read).toEqual([])
  })

  it('erro conta e fica marcado; sem resultado = pendente', () => {
    const msgs = [
      user(),
      read('sumiu.ts', {}, 'File does not exist.', true),
      read('lendo.ts', {}, false),
      tool('Bash', { command: 'npm test' }, 'falhou', true),
      tool('Bash', { command: 'ls' }, 'ok')
    ]
    const acts = buildTurnActions(msgs)
    expect(acts.read.map((r) => [r.name, r.error, r.pending])).toEqual([
      ['sumiu.ts', true, false],
      ['lendo.ts', false, true]
    ])
    const [cmds] = acts.other
    expect(cmds).toMatchObject({ kind: 'command', label: 'Comandos', errors: 1 })
    expect(cmds.items.map((x) => [x.summary, x.error])).toEqual([
      ['npm test', true],
      ['ls', false]
    ])
  })

  it('outras ações agrupadas na ordem fixa, com ferramenta e resumo', () => {
    const msgs = [
      user(),
      tool('Task', { subagent_type: 'executor', description: 'Faz a tarefa' }, 'ok'),
      tool('Agent', { description: 'Só descrição' }, 'ok'),
      tool('mcp__memory__memory_list', { query: 'build' }, 'ok'),
      tool('mcp__memory__memory_status', {}, 'ok'),
      tool('mcp__chrome__chrome_click', { selector: '#ok' }, 'ok'),
      tool('mcp__browser__browser_navigate', { url: 'https://a.dev' }, 'ok'),
      tool('WebFetch', { url: 'https://b.dev', prompt: 'x' }, 'ok'),
      tool('WebSearch', { query: 'vitest mock' }, 'ok'),
      tool('PowerShell', { command: 'Get-ChildItem\nmais' }, 'ok'),
      tool('Glob', { pattern: '**/*.ts' }, 'ok'),
      tool('Grep', { pattern: 'buildTabs', path: 'src' }, 'ok'),
      tool('TodoWrite', { todos: [] }, 'ok')
    ]
    const other = buildTurnActions(msgs).other
    expect(other.map((g) => [g.label, g.items.length])).toEqual([
      ['Buscas', 2],
      ['Comandos', 1],
      ['Web', 4],
      ['Consultas de memória', 2],
      ['Delegou', 2]
    ])
    const flat = Object.fromEntries(other.flatMap((g) => g.items.map((x) => [x.tool, x.summary])))
    expect(flat).toEqual({
      Grep: 'buildTabs em src',
      Glob: '**/*.ts',
      PowerShell: 'Get-ChildItem',
      WebSearch: 'vitest mock',
      WebFetch: 'https://b.dev',
      mcp__browser__browser_navigate: 'https://a.dev',
      mcp__chrome__chrome_click: '#ok',
      mcp__memory__memory_list: 'build',
      mcp__memory__memory_status: '',
      Task: 'executor: Faz a tarefa',
      Agent: 'Só descrição'
    })
  })

  it('resumo cortado em SUMMARY_MAX', () => {
    const msgs = [user(), tool('Bash', { command: 'x'.repeat(200) }, 'ok')]
    const s = buildTurnActions(msgs).other[0].items[0].summary
    expect(s).toHaveLength(SUMMARY_MAX)
    expect(s.endsWith('…')).toBe(true)
  })

  it('memória lida: Read dentro da pasta de memórias, com barras e caixa diferentes; não entra em Lidos', () => {
    const msgs = [
      user(),
      tool('Read', { file_path: 'd:/onedrive/DOCUMENTOS/agent-code/memories/projeto/build.md' }, 'x'),
      tool('Read', { file_path: `${MEM}\\user.md`, offset: 1, limit: 3 }, 'x'),
      tool('Read', { file_path: 'D:\\OneDrive\\Documentos\\agent-code\\memories-old\\x.md' }, 'x')
    ]
    const acts = buildTurnActions(msgs, { memoriesDir: 'D:/OneDrive/Documentos/agent-code/memories/' })
    expect(acts.memory.read.map((r) => [r.relPath, r.offset, r.limit])).toEqual([
      ['projeto/build.md', null, null],
      ['user.md', 1, 3]
    ])
    expect(acts.read.map((r) => r.name)).toEqual(['x.md'])
    // sem pasta de memórias, tudo é Lido comum
    expect(buildTurnActions(msgs).read).toHaveLength(3)
  })

  it('memória gravada: memory_propose (com ou sem prefixo MCP), com rel_path, op e erro', () => {
    const msgs = [
      user(),
      tool('mcp__memory__memory_propose', { op: 'create', rel_path: 'projeto/a.md', body: 'x' }, 'Memória aplicada: projeto/a.md.'),
      tool('memory_propose', { op: 'update', rel_path: 'b.md' }, 'Conflito', true),
      tool('mcp__memory__memory_propose', { op: 'retire', rel_path: 'c.md' }, false)
    ]
    expect(buildTurnActions(msgs).memory.saved.map((s) => [s.relPath, s.op, s.error, s.pending])).toEqual([
      ['projeto/a.md', 'create', false, false],
      ['b.md', 'update', true, false],
      ['c.md', 'retire', false, true]
    ])
  })

  it('memória enviada: a lista recebida, sem vazios e sem repetição', () => {
    const acts = buildTurnActions([user()], { memoriesSent: ['a.md', '', 'b.md', 'a.md'] })
    expect(acts.memory.sent).toEqual(['a.md', 'b.md'])
    expect(buildTurnActions([]).memory).toEqual({ read: [], saved: [], sent: [] })
  })

  describe('modelo que fez', () => {
    const by = <T extends ToolUseMessage>(model: string, m: T): T => ({ ...m, model })
    const OPUS = 'claude-opus-5-5'
    const SOL = 'gpt-6.1-sol'

    it('cada ação leva o modelo do seu tool-use, em todas as seções', () => {
      const msgs = [
        user(),
        by(OPUS, read('a.ts')),
        by(OPUS, tool('Read', { file_path: `${MEM}\\m.md` }, 'x')),
        by(SOL, tool('mcp__memory__memory_propose', { op: 'create', rel_path: 'n.md' }, 'ok')),
        by(SOL, tool('Grep', { pattern: 'x' }, 'ok')),
        by(SOL, tool('Bash', { command: 'ls' }, 'ok')),
        by(SOL, tool('WebSearch', { query: 'q' }, 'ok')),
        by(SOL, tool('Agent', { description: 'd' }, 'ok'))
      ]
      const acts = buildTurnActions(msgs, { memoriesDir: MEM, memoriesSent: ['m.md'] })
      expect(acts.read[0].model).toBe(OPUS)
      expect(acts.memory.read[0].model).toBe(OPUS)
      expect(acts.memory.saved[0].model).toBe(SOL)
      expect(acts.other.flatMap((g) => g.items.map((x) => x.model))).toEqual([SOL, SOL, SOL, SOL])
      // a enviada é uma lista de nomes: quem a pôs foi o app, não um modelo
      expect(acts.memory.sent).toEqual(['m.md'])
      expect(acts.models).toEqual([OPUS, SOL])
    })

    it('arquivo mexido por dois modelos guarda os dois, na ordem', () => {
      const msgs = [user(), by(OPUS, edit('a.ts')), by(SOL, edit('a.ts')), by(SOL, edit('b.ts'))]
      const acts = buildTurnActions(msgs)
      expect(acts.changed.map((t) => [t.name, t.models])).toEqual([
        ['b.ts', [SOL]],
        ['a.ts', [OPUS, SOL]]
      ])
      expect(acts.models).toEqual([OPUS, SOL])
    })

    it('arquivo de turno anterior leva os modelos daquele turno, mas não entra nos do turno', () => {
      const msgs = [user(), by(OPUS, edit('velho.ts')), user(), by(SOL, read('x.ts'))]
      const acts = buildTurnActions(msgs)
      expect(acts.changed[0].models).toEqual([OPUS])
      expect(acts.models).toEqual([SOL])
    })

    it('evento antigo sem modelo (ou vazio): ação sem modelo e listas vazias', () => {
      const msgs = [user(), edit('a.ts'), read('b.ts'), by('', tool('Bash', { command: 'ls' }, 'ok'))]
      const acts = buildTurnActions(msgs)
      expect(acts.changed[0].models).toEqual([])
      expect(acts.read[0]).not.toHaveProperty('model')
      expect(acts.other[0].items[0]).not.toHaveProperty('model')
      expect(acts.models).toEqual([])
    })

    it('subagente: buildTurnActions sobre a trilha dele devolve o modelo dele', () => {
      const msgs = trackMessages({
        id: 'task-1', label: 'Explore: ache', status: 'done', startedAt: 1, stepCount: 2,
        steps: [
          { id: 's1', name: 'Grep', input: { pattern: 'x' }, startedAt: 1, endedAt: 2, result: 'ok', model: 'claude-haiku-4-5' },
          { id: 's2', name: 'Read', input: { file_path: P + 'a.ts' }, startedAt: 2, endedAt: 3, result: 'ok', model: 'claude-haiku-4-5' }
        ]
      })
      const acts = buildTurnActions(msgs)
      expect(acts.models).toEqual(['claude-haiku-4-5'])
      expect(acts.read[0].model).toBe('claude-haiku-4-5')
      expect(acts.other[0].items[0].model).toBe('claude-haiku-4-5')
    })
  })

  it('turno anterior não conta em nenhuma seção do turno', () => {
    const msgs = [
      user(),
      tool('Grep', { pattern: 'x' }, 'ok'),
      tool('mcp__memory__memory_propose', { op: 'create', rel_path: 'a.md' }, 'ok'),
      tool('Read', { file_path: `${MEM}\\a.md` }, 'ok'),
      user()
    ]
    const acts = buildTurnActions(msgs, { memoriesDir: MEM })
    expect(acts.other).toEqual([])
    expect(acts.memory.saved).toEqual([])
    expect(acts.memory.read).toEqual([])
  })
})
