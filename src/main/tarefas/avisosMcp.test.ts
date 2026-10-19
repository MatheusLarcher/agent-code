// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAvisosTools } from './avisosMcp'
import type { AvisoTarefa } from './regras'
import { TarefasServico } from './servico'
import { MemoriaTarefaRepo } from './tarefasTestKit'

/** O MCP `avisos`: a tarefa nasce na conversa da sessão; outra conversa não mexe nela. */

const T0 = Date.parse('2026-10-19T12:00:00-03:00')
type Handler = (input: Record<string, unknown>, extra: unknown) => Promise<{ content: { text: string }[] }>

let servico: TarefasServico
let avisos: AvisoTarefa[]
beforeEach(() => {
  vi.useFakeTimers({ now: T0 })
  avisos = []
  servico = new TarefasServico({ repository: () => new MemoriaTarefaRepo(), instalacao: () => 'pc-a', executarMonitor: async () => ({ resultado: 'nao-bateu' }), avisar: (a) => avisos.push(a) })
})
afterEach(() => {
  servico.parar()
  vi.useRealTimers()
})

function ferramentas(convId: string): Record<string, Handler> {
  const tools = buildAvisosTools({ servico, convId, cwd: 'C:\\p' }) as unknown as { name: string; handler: Handler }[]
  return Object.fromEntries(tools.map((t) => [t.name, t.handler]))
}
const call = async (h: Handler, input: Record<string, unknown>): Promise<string> => (await h(input, {})).content[0].text

describe('MCP avisos', () => {
  it('lembrete e monitor nascem na conversa da sessão; listar mostra só os dela', async () => {
    const c1 = ferramentas('c1')
    expect(await call(c1.aviso_lembrete, { titulo: 'Renovar passaporte', quando: '2026-10-20T09:00:00-03:00' })).toMatch(/^Lembrete criado:\n- .+ \[lembrete · ativa\] Renovar passaporte · uma vez em 20\/10 09:00/)
    expect(await call(c1.aviso_monitor, { titulo: 'Passagem', condicao: 'abaixo de R$ 3.000', intervalo_min: 10 })).toMatch(/a cada 10 min .*modelo claude-haiku-5-5/)
    expect(servico.vistas('c1').map((t) => t.convId)).toEqual(['c1', 'c1'])
    expect(await call(ferramentas('c2').aviso_listar, {})).toBe('Nenhuma tarefa agendada nesta conversa.')
    expect((await call(c1.aviso_listar, {})).split('\n')).toHaveLength(2)
  })

  it('recusa agenda ambígua ou inválida com motivo legível', async () => {
    const c1 = ferramentas('c1')
    expect(await call(c1.aviso_lembrete, { titulo: 'X' })).toBe('Lembrete não criado: informe exatamente UM entre quando, intervalo_min e diario_hora.')
    expect(await call(c1.aviso_lembrete, { titulo: 'X', quando: 'amanhã', intervalo_min: 5 })).toMatch(/exatamente UM/)
    expect(await call(c1.aviso_lembrete, { titulo: 'X', quando: '2026-10-18T09:00:00-03:00' })).toMatch(/já passou/)
    expect(await call(c1.aviso_monitor, { titulo: 'X', condicao: 'y', diario_hora: '9h' })).toMatch(/HH:MM/)
  })

  it('pausar, retomar e cancelar pelo chat; outra conversa não mexe', async () => {
    const c1 = ferramentas('c1')
    await call(c1.aviso_monitor, { titulo: 'Passagem', condicao: 'abaixo de R$ 3.000', intervalo_min: 10 })
    const id = servico.vistas('c1')[0].id
    expect(await call(ferramentas('c2').aviso_cancelar, { id })).toMatch(/de outra conversa/)
    expect(await call(c1.aviso_pausar, { id })).toMatch(/^Pausada:/)
    expect(await call(c1.aviso_pausar, { id, retomar: true })).toMatch(/^Retomada:/)
    // Depois da ação, o estado de agora (o usuário também mexe pela bolinha): sem "continua ativo" de memória.
    expect(await call(c1.aviso_cancelar, { id })).toBe('Tarefa cancelada.\nTarefas desta conversa agora:\nNenhuma tarefa agendada nesta conversa.')
    expect(servico.vistas('c1')).toHaveLength(0)
  })

  it('aviso_notificar avisa já, com a conversa de origem', async () => {
    expect(await call(ferramentas('c1').aviso_notificar, { titulo: 'Build pronto', mensagem: 'Deu certo.' })).toBe('Aviso enviado.')
    expect(avisos).toEqual([{ tipo: 'agora', convId: 'c1', tarefaId: null, titulo: 'Build pronto', texto: 'Deu certo.' }])
  })
})
