import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { activeScopesFor, writeScopeDenial } from '../tasks/writeScopeGuard'
import {
  handoffSkillDenial,
  MANAGER_ALLOWED_TOOLS,
  PLANNING_DISALLOWED_TOOLS,
  planningPreToolDecision,
  planningRequiresBashApproval,
  planningSandboxDir,
  planningSandboxGlob,
  planningScopedTask,
  planningSkillDenial,
  planningToolDenial
} from './planningPolicy'

/**
 * A política do Manager contra o writeScopeDenial REAL: o ponto é provar que o
 * ScopedTask que planningScopedTask monta produz as recusas certas no mesmo gate
 * que as tarefas usam — não reimplementar o casamento de globs aqui.
 */

// Não toca o disco: o gate só compara caminhos.
const cwd = path.resolve('/projeto-planning/app')
const slug = 'checkout'
const task = planningScopedTask(cwd, slug)
const at = (...parts: string[]): string => path.join(cwd, ...parts)
const forBash = (p: string): string => p.split(path.sep).join('/')
const denial = (toolName: string, input: Record<string, unknown>): string | null =>
  writeScopeDenial([task], toolName, input)

describe('planningScopedTask', () => {
  it('allow só o _sandbox do slug, holder null e lease que não expira', () => {
    expect(task.writeScope).toEqual({ allow: ['docs/spec/checkout/_sandbox/**'], deny: [] })
    expect(task.holder).toBeNull()
    expect(task.projectCwd).toBe(cwd)
    expect(planningSandboxGlob(slug)).toBe('docs/spec/checkout/_sandbox/**')
    // Vale para o agente principal e para qualquer subagente, hoje e daqui a séculos.
    expect(activeScopesFor([task], null)).toEqual([task])
    expect(activeScopesFor([task], 'sub-1', Date.parse('2999-01-01T00:00:00Z'))).toEqual([task])
  })

  it('recusa slug inválido', () => {
    expect(() => planningScopedTask(cwd, '../fora')).toThrow(/slug inválido/)
    expect(() => planningScopedTask(cwd, 'Maiuscula')).toThrow(/slug inválido/)
  })

  it('planningSandboxDir aponta para docs/spec/<slug>/_sandbox', () => {
    expect(planningSandboxDir(cwd, slug)).toBe(at('docs', 'spec', 'checkout', '_sandbox'))
  })
})

describe('writeScopeDenial com o escopo do Manager', () => {
  it('Write em src/x.ts é negado (absoluto ou relativo)', () => {
    expect(denial('Write', { file_path: at('src', 'x.ts') })).toMatch(/recusado pelo escopo/)
    expect(denial('Write', { file_path: 'src/x.ts' })).toMatch(/recusado pelo escopo/)
    expect(denial('Edit', { file_path: at('src', 'x.ts') })).toMatch(/recusado pelo escopo/)
  })

  it('Write dentro de docs/spec/<slug>/_sandbox é permitido', () => {
    expect(denial('Write', { file_path: at('docs', 'spec', slug, '_sandbox', 'a.ts') })).toBeNull()
    expect(denial('Write', { file_path: at('docs', 'spec', slug, '_sandbox', 'poc', 'b.test.ts') })).toBeNull()
    expect(denial('Edit', { file_path: at('docs', 'spec', slug, '_sandbox', 'a.ts') })).toBeNull()
  })

  it('cards e roteiro só mudam por plan_*: Write direto é negado', () => {
    expect(denial('Write', { file_path: at('docs', 'spec', slug, 'cards', 'x.md') })).toMatch(/não casa o allow/)
    expect(denial('Write', { file_path: at('docs', 'spec', slug, '_roteiro.md') })).toMatch(/não casa o allow/)
    expect(denial('Write', { file_path: at('docs', 'spec', slug, '_handoff', '2026-01-01-01.md') })).not.toBeNull()
    // Escapar do sandbox com ".." não engana o gate.
    expect(denial('Write', { file_path: at('docs', 'spec', slug, '_sandbox', '..', 'cards', 'x.md') })).not.toBeNull()
    expect(denial('Write', { file_path: at('docs', 'spec', slug, '_sandbox-falso', 'a.ts') })).not.toBeNull()
  })

  it('sandbox de OUTRO planejamento é negado', () => {
    expect(denial('Write', { file_path: at('docs', 'spec', 'outro-slug', '_sandbox', 'a.ts') })).toMatch(/não casa o allow/)
  })

  it('fora do projeto é negado', () => {
    expect(denial('Write', { file_path: path.resolve('/outro-lugar/a.ts') })).toMatch(/fora do projeto/)
  })

  it('Bash `echo x > src/a.ts` é negado', () => {
    expect(denial('Bash', { command: 'echo x > src/a.ts' })).toMatch(/Bash recusado/)
  })

  it('Bash gravando no sandbox com caminho absoluto é permitido', () => {
    const target = forBash(at('docs', 'spec', slug, '_sandbox', 'saida.txt'))
    expect(denial('Bash', { command: `echo x > ${target}` })).toBeNull()
  })

  it('Bash com alvo não determinável é negado', () => {
    expect(denial('Bash', { command: 'echo x > $SAIDA' })).toMatch(/não dá para conferir o destino/)
    expect(denial('Bash', { command: 'cd docs && echo x > a.txt' })).toMatch(/não dá para conferir o destino/)
    expect(denial('Bash', { command: 'git checkout -- .' })).toMatch(/não dá para conferir o destino/)
  })

  it('Bash sem escrita não é negado pelo escopo', () => {
    expect(denial('Bash', { command: 'git status' })).toBeNull()
    expect(denial('Bash', { command: 'git log --oneline -5 && ls src' })).toBeNull()
  })
})

describe('ferramentas e skills do Manager', () => {
  it('PLANNING_DISALLOWED_TOOLS: sem subagentes, notebook nem os outros jeitos de rodar comando', () => {
    expect([...PLANNING_DISALLOWED_TOOLS]).toEqual([
      'Agent',
      'Task',
      'NotebookEdit',
      'Monitor',
      'PowerShell',
      'Workflow',
      'EnterWorktree',
      'CronCreate',
      'RemoteTrigger'
    ])
  })

  it('planningToolDenial: allowlist no Manager — o que não está nela é negado com motivo', () => {
    const manager = { planning: { slug } }
    const allowed = [
      'Read', 'Glob', 'Grep', 'LS', 'Write', 'Edit', 'MultiEdit', 'Bash', 'BashOutput', 'KillShell', 'KillBash',
      'WebFetch', 'WebSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'AskUserQuestion',
      'Skill', 'ToolSearch', 'mcp__planning__plan_read', 'mcp__planning__plan_card_create', 'mcp__memory__memory_list'
    ]
    for (const tool of allowed) expect(planningToolDenial(manager, tool), tool).toBeNull()
    expect([...MANAGER_ALLOWED_TOOLS].every((tool) => planningToolDenial(manager, tool) === null)).toBe(true)
    const denied = [
      'Monitor', 'PowerShell', 'Workflow', 'EnterWorktree', 'CronCreate', 'RemoteTrigger', 'Agent', 'Task',
      'NotebookEdit', 'ScheduleWakeup', 'ExitPlanMode', 'mcp__powerbi__x', 'mcp__browser__browser_navigate',
      'mcp__windows__click', 'mcp__tasks__task_claim', 'mcp__planningx__y', 'bash', 'read', ''
    ]
    for (const tool of denied) {
      expect(planningToolDenial(manager, tool), tool).toMatch(/não está disponível na sessão do Agent Manager/)
      expect(planningToolDenial(manager, tool)).toContain(`"${tool}"`)
    }
  })

  it('planningToolDenial: fora do Manager nunca nega', () => {
    for (const role of [{}, { planning: undefined }, { planning: null }]) {
      for (const tool of ['Monitor', 'PowerShell', 'mcp__powerbi__x', 'Agent', 'Read']) {
        expect(planningToolDenial(role, tool), tool).toBeNull()
      }
    }
  })

  it('planningRequiresBashApproval: no Manager, Bash (e PowerShell) sempre pedem aprovação', () => {
    const manager = { planning: { slug } }
    expect(planningRequiresBashApproval(manager, 'Bash')).toBe(true)
    expect(planningRequiresBashApproval(manager, 'PowerShell')).toBe(true)
    // Leitura, escrita no sandbox e plan_* seguem as regras de sempre.
    for (const tool of ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebFetch', 'BashOutput', 'mcp__planning__plan_read', 'bash']) {
      expect(planningRequiresBashApproval(manager, tool), tool).toBe(false)
    }
  })

  it('planningRequiresBashApproval: fora do Manager nunca obriga (sessão comum e handoff)', () => {
    expect(planningRequiresBashApproval({}, 'Bash')).toBe(false)
    expect(planningRequiresBashApproval({ planning: undefined }, 'Bash')).toBe(false)
    expect(planningRequiresBashApproval({ planning: null }, 'PowerShell')).toBe(false)
    const handoff: { planning?: unknown; handoff: { slug: string } } = { handoff: { slug } }
    expect(planningRequiresBashApproval(handoff, 'Bash')).toBe(false)
  })

  it('planningSkillDenial recusa skills de execução/replanejamento, com variantes', () => {
    const blocked = [
      'planejar',
      'brainstorming',
      'writing-plans',
      'executing-plans',
      'subagent-driven-development',
      'subagent-driven-development.agent-code-new',
      'finishing-a-development-branch',
      'using-git-worktrees',
      'superpowers:brainstorming',
      '/planejar',
      'Writing-Plans'
    ]
    for (const name of blocked) {
      const reason = planningSkillDenial(name)
      expect(reason, name).toMatch(/não roda na sessão do Agent Manager/)
      expect(reason).toContain(name)
      expect(reason).toContain('mcp__planning__plan_')
    }
  })

  it('planningSkillDenial deixa passar as demais skills', () => {
    for (const name of ['rtk', 'browser', 'code-review', 'planejamento', 'brainstorm', 'plans', '', undefined, 42]) {
      expect(planningSkillDenial(name), String(name)).toBeNull()
    }
  })

  it('handoffSkillDenial: no primeiro turno recusa planejar/brainstorming/writing-plans', () => {
    for (const name of ['planejar', 'brainstorming', 'writing-plans', 'superpowers:writing-plans', 'planejar.v2']) {
      expect(handoffSkillDenial(name, false), name).toMatch(/primeiro turno desta conversa de handoff/)
    }
    // Executar o plano é justamente o que o handoff quer.
    expect(handoffSkillDenial('executing-plans', false)).toBeNull()
    expect(handoffSkillDenial('subagent-driven-development', false)).toBeNull()
    expect(handoffSkillDenial('rtk', false)).toBeNull()
  })

  it('handoffSkillDenial: depois do primeiro turno, nada é recusado', () => {
    for (const name of ['planejar', 'brainstorming', 'writing-plans']) {
      expect(handoffSkillDenial(name, true), name).toBeNull()
    }
  })
})

describe('planningPreToolDecision (hook PreToolUse do Manager)', () => {
  const manager = { cwd, planning: { slug } }
  const decide = (toolName: string, input: unknown): ReturnType<typeof planningPreToolDecision> =>
    planningPreToolDecision(manager, toolName, input)
  const sandbox = (...parts: string[]): string => at('docs', 'spec', slug, '_sandbox', ...parts)

  it('escrita de arquivo fora do _sandbox: deny com o motivo do writeScopeDenial', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['Write', { file_path: at('src', 'x.ts'), content: 'x' }],
      ['Write', { file_path: 'src/x.ts', content: 'x' }],
      ['Edit', { file_path: at('src', 'x.ts'), old_string: 'a', new_string: 'b' }],
      ['MultiEdit', { file_path: at('src', 'x.ts'), edits: [] }],
      ['Write', { file_path: at('docs', 'spec', slug, 'cards', 'x.md'), content: 'x' }]
    ]
    for (const [tool, input] of cases) {
      const res = await decide(tool, input)
      expect(res?.decision, `${tool} ${String(input.file_path)}`).toBe('deny')
      expect(res?.reason).toBe(writeScopeDenial([task], tool, input))
      expect(res?.reason).toMatch(/recusado pelo escopo/)
    }
  })

  it('escrita dentro do _sandbox: o hook não opina', async () => {
    expect(await decide('Write', { file_path: sandbox('a.ts'), content: 'x' })).toBeNull()
    expect(await decide('Edit', { file_path: sandbox('poc', 'b.ts'), old_string: 'a', new_string: 'b' })).toBeNull()
    expect(await decide('MultiEdit', { file_path: sandbox('c.ts'), edits: [] })).toBeNull()
  })

  it('Bash que escreve fora do _sandbox (ou para destino indeterminável): deny, sem perguntar', async () => {
    const out = await decide('Bash', { command: 'echo x > src/a.ts' })
    expect(out?.decision).toBe('deny')
    expect(out?.reason).toMatch(/Bash recusado/)
    expect((await decide('Bash', { command: 'echo x > $SAIDA' }))?.decision).toBe('deny')
  })

  it('Bash que o escopo não recusou: ask (inclusive gravando no _sandbox)', async () => {
    const status = await decide('Bash', { command: 'git status' })
    expect(status).toEqual({ decision: 'ask', reason: expect.stringContaining('Bash') })
    expect((await decide('Bash', { command: `echo x > ${forBash(sandbox('saida.txt'))}` }))?.decision).toBe('ask')
  })

  it('fora da allowlist: Monitor, PowerShell, mcp__powerbi__x, EnterWorktree e afins → deny', async () => {
    const cases: Array<[string, unknown]> = [
      ['Monitor', { command: 'tail -f log.txt' }],
      ['PowerShell', { command: 'Get-ChildItem' }],
      ['mcp__powerbi__x', {}],
      ['EnterWorktree', {}],
      ['Workflow', {}],
      ['CronCreate', {}],
      ['RemoteTrigger', {}],
      ['NotebookEdit', { notebook_path: at('src', 'n.ipynb'), new_source: '' }],
      ['Agent', { prompt: 'x' }]
    ]
    for (const [tool, input] of cases) {
      const res = await decide(tool, input)
      expect(res?.decision, tool).toBe('deny')
      expect(res?.reason).toBe(planningToolDenial(manager, tool))
    }
  })

  it('Skill de execução/replanejamento: deny também no hook; as demais o hook não opina', async () => {
    const out = await decide('Skill', { skill: 'planejar' })
    expect(out?.decision).toBe('deny')
    expect(out?.reason).toMatch(/não roda na sessão do Agent Manager/)
    expect((await decide('Skill', { name: 'superpowers:brainstorming' }))?.decision).toBe('deny')
    expect(await decide('Skill', { skill: 'code-review' })).toBeNull()
  })

  it('leitura, pesquisa, plan_*, ToolSearch e demais da allowlist: null', async () => {
    const tools = ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'TodoWrite', 'mcp__planning__plan_read', 'mcp__memory__memory_list']
    for (const tool of tools) {
      expect(await decide(tool, { file_path: at('src', 'x.ts'), pattern: '*', query: 'x' }), tool).toBeNull()
    }
  })

  it('entrada que não é objeto: nada a conferir no escopo; Bash ainda pergunta', async () => {
    for (const input of [undefined, null, 'src/x.ts', 42, ['src/x.ts']]) {
      expect(await decide('Write', input), String(input)).toBeNull()
      expect((await decide('Bash', input))?.decision, String(input)).toBe('ask')
    }
  })

  it('fora do Manager (sessão comum e handoff): sempre null', async () => {
    const roles = [{ cwd }, { cwd, planning: undefined }, { cwd, planning: null }, { cwd, handoff: { slug } }]
    for (const role of roles) {
      expect(await planningPreToolDecision(role, 'Write', { file_path: at('src', 'x.ts'), content: 'x' })).toBeNull()
      expect(await planningPreToolDecision(role, 'Bash', { command: 'echo x > src/a.ts' })).toBeNull()
      expect(await planningPreToolDecision(role, 'Bash', { command: 'git status' })).toBeNull()
      expect(await planningPreToolDecision(role, 'PowerShell', { command: 'Get-ChildItem' })).toBeNull()
      expect(await planningPreToolDecision(role, 'Monitor', { command: 'x' })).toBeNull()
      expect(await planningPreToolDecision(role, 'mcp__powerbi__x', {})).toBeNull()
    }
  })
})
