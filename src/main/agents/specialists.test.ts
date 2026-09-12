// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { buildSpecialistAgents } from './specialists'

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

  it('o executor herda todas as ferramentas — ele implementa', () => {
    const executor = buildSpecialistAgents({ ledger: true, memory: true }).executor
    expect(executor.tools).toBeUndefined()
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
})
