// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildSpecialistAgents } from './specialists'
import { MODEL_EFFORT } from '../../shared/ipc'

describe('cadastro de especialistas', () => {
  it('sem registro de tarefas, não anuncia executor nem crítico', () => {
    // Oferecer um papel que falha na primeira chamada é pior que não oferecer.
    const agents = buildSpecialistAgents({ ledger: false, memory: false })
    expect(Object.keys(agents)).toEqual(['navegador-de-codigo'])
  })

  it('com registro, entram executor e crítico', () => {
    const agents = buildSpecialistAgents({ ledger: true, memory: false })
    expect(Object.keys(agents).sort()).toEqual(['critico', 'executor', 'navegador-de-codigo'])
  })

  it('o agente de memória segue o serviço de memória', () => {
    expect(buildSpecialistAgents({ ledger: false, memory: true }).memoria).toBeDefined()
    expect(buildSpecialistAgents({ ledger: false, memory: false }).memoria).toBeUndefined()
  })

  it('não existe subagente "supervisor" — quem supervisiona é a thread principal', () => {
    const agents = buildSpecialistAgents({ ledger: true, memory: true })
    expect(agents.supervisor).toBeUndefined()
  })

  it('o crítico não pode escrever código', () => {
    const critic = buildSpecialistAgents({ ledger: true, memory: true }).critico
    expect(critic.tools).toBeDefined()
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(critic.tools).not.toContain(tool)
    }
    // Mas precisa rodar o teste que o entregável alega, e fechar a tarefa.
    expect(critic.tools).toContain('Bash')
    expect(critic.tools).toContain('mcp__tasks__task_transition')
  })

  it('o navegador de código só lê', () => {
    const nav = buildSpecialistAgents({ ledger: true, memory: true })['navegador-de-codigo']
    expect(nav.tools).toEqual(['Read', 'Glob', 'Grep'])
  })

  it('o executor herda as ferramentas — ele implementa tarefa arbitrária', () => {
    const executor = buildSpecialistAgents({ ledger: true, memory: true }).executor
    expect(executor.tools).toBeUndefined()
  })

  it('mas o executor não dirige outros apps nem reinicia o app', () => {
    // Reiniciar mataria o supervisor que o delegou, no meio do trabalho dos
    // outros; dirigir o Windows não faz parte de implementar uma tarefa.
    const executor = buildSpecialistAgents({ ledger: true, memory: true }).executor
    expect(executor.disallowedTools).toEqual(['mcp__windows', 'mcp__app'])
  })

  it('o crítico já vem com a skill de revisão carregada', () => {
    const critic = buildSpecialistAgents({ ledger: true, memory: false }).critico
    expect(critic.skills).toEqual(['code-review'])
  })

  it('quem não implementa não recebe ferramenta de escrita nem MCP pesado', () => {
    const agents = buildSpecialistAgents({ ledger: true, memory: true })
    for (const name of ['critico', 'navegador-de-codigo', 'memoria']) {
      const tools = agents[name].tools ?? []
      expect(tools.length, name).toBeGreaterThan(0)
      for (const heavy of ['mcp__browser', 'mcp__android', 'mcp__windows', 'mcp__app']) {
        expect(tools.some((t) => t.startsWith(heavy)), `${name} × ${heavy}`).toBe(false)
      }
    }
  })

  it('nenhum especialista fixa modelo: o do usuário vale', () => {
    const agents = buildSpecialistAgents({ ledger: true, memory: true })
    for (const agent of Object.values(agents)) expect(agent.model).toBeUndefined()
  })

  it('todo especialista tem descrição e prompt não vazios', () => {
    const agents = buildSpecialistAgents({ ledger: true, memory: true })
    expect(Object.keys(agents)).toHaveLength(4)
    for (const [name, agent] of Object.entries(agents)) {
      expect(agent.description.length, name).toBeGreaterThan(40)
      expect(agent.prompt.length, name).toBeGreaterThan(200)
    }
  })

  it('o prompt do crítico manda devolver pela fila, não para "running"', () => {
    // review→running deixa a tarefa encalhada quando o executor anterior já morreu.
    const critic = buildSpecialistAgents({ ledger: true, memory: false }).critico
    expect(critic.prompt).toContain('"failed" para "pending"')
    expect(critic.prompt).toContain('SEM `lease_token`')
  })

  it('ferramentas no prompt do executor: testes dos tocados, suíte uma vez, espera em background, empacotar só quando pedido', () => {
    const executor = buildSpecialistAgents({ ledger: true, memory: false }).executor
    expect(executor.prompt).toContain('rode só os testes dos arquivos que você tocou')
    expect(executor.prompt).toContain('`npx tsc -p tsconfig.node.json --noEmit`')
    expect(executor.prompt).toContain('rodam UMA vez, no fechamento do envio')
    expect(executor.prompt).toContain('(`run_in_background`)')
    expect(executor.prompt).toContain('Nunca um laço com `sleep` dentro do turno')
    expect(executor.prompt).toContain('só quando a tarefa pede o artefato, e uma vez')
  })

  it('autoCompactWindow de 120k em executor e crítico; navegador e memória herdam', () => {
    const agents = buildSpecialistAgents({ ledger: true, memory: true })
    expect(agents.executor.autoCompactWindow).toBe(120_000)
    expect(agents.critico.autoCompactWindow).toBe(120_000)
    expect(agents['navegador-de-codigo'].autoCompactWindow).toBeUndefined()
    expect(agents.memoria.autoCompactWindow).toBeUndefined()
  })

  it('esforço por papel: executor high, crítico medium, navegador e memória low (o principal fica com o da conversa)', () => {
    const agents = buildSpecialistAgents({ ledger: true, memory: true, model: 'claude-opus-5-5' })
    expect(agents.executor.effort).toBe('high')
    expect(agents.critico.effort).toBe('medium')
    expect(agents['navegador-de-codigo'].effort).toBe('low')
    expect(agents.memoria.effort).toBe('low')
    // Modelo da conta (sem modelo fixo) ou Automático: o mesmo.
    expect(buildSpecialistAgents({ ledger: true, memory: false }).executor.effort).toBe('high')
    expect(buildSpecialistAgents({ ledger: true, memory: false, model: 'auto' }).critico.effort).toBe('medium')
  })

  it('modelo sem esforço (Ollama): o campo é omitido; modelo com escada curta: recortado ao teto dele', () => {
    const ollama = buildSpecialistAgents({ ledger: true, memory: true, model: 'qwen3-coder:480b-cloud' })
    for (const agent of Object.values(ollama)) expect(agent.effort).toBeUndefined()
    MODEL_EFFORT['modelo-curto-teste'] = ['low', 'medium']
    try {
      const curto = buildSpecialistAgents({ ledger: true, memory: false, model: 'modelo-curto-teste' })
      expect(curto.executor.effort).toBe('medium')
      expect(curto.critico.effort).toBe('medium')
      expect(curto['navegador-de-codigo'].effort).toBe('low')
    } finally {
      delete MODEL_EFFORT['modelo-curto-teste']
    }
  })

  it('omitClaudeMd só em quem lê (navegador e crítico); o executor mantém as regras do projeto', () => {
    const agents = buildSpecialistAgents({ ledger: true, memory: true })
    expect(agents['navegador-de-codigo'].omitClaudeMd).toBe(true)
    expect(agents.critico.omitClaudeMd).toBe(true)
    expect(agents.executor.omitClaudeMd).toBeUndefined()
    // Ninguém roda em segundo plano: o supervisor precisa do resultado para cobrar evidência.
    for (const agent of Object.values(agents)) expect(agent.background).toBeUndefined()
  })

  it('pipeline nos prompts: mapa do código, uma revisão, mesmo executor vivo', () => {
    const agents = buildSpecialistAgents({ ledger: true, memory: true })
    expect(agents.executor.prompt).toContain('O mapa do código vem no seu prompt')
    expect(agents.executor.prompt).toContain('não reexplore o projeto')
    expect(agents.executor.description).toContain('mapa do código')
    expect(agents.critico.prompt).toContain('Uma revisão só')
    expect(agents.critico.prompt).toContain('o preferido, quando ele existe')
    expect(agents.critico.prompt).toContain('roda sem o CLAUDE.md do projeto')
    expect(agents.critico.description).toContain('test_run alegado ou 3+ arquivos')
  })
})
