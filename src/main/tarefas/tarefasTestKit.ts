import type { Tarefa, TarefaRodada } from '../../shared/tarefas'
import type { TarefaClaim, TarefaEstadoPatch, TarefaFimRodada, TarefaRegistro, TarefaRepository } from '../persistence/tarefaTypes'

/**
 * Repositório de tarefas na memória para os testes do agendador, com a MESMA
 * regra de trava do SQL (postgresTarefas.ts): vencida, trava livre/vencida/minha,
 * cortesia para quem não criou; o fim grava com a trava desta rodada ou, vencida,
 * se nenhuma rodada mais nova foi gravada. Compartilhado entre duas instâncias,
 * faz o papel do banco dos dois PCs.
 */
export class MemoriaTarefaRepo implements TarefaRepository {
  readonly tarefas = new Map<string, TarefaRegistro>()
  readonly rodadas: TarefaRodada[] = []
  offline = false

  private check(): void {
    if (this.offline) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
  }

  async listTarefas(): Promise<TarefaRegistro[]> {
    this.check()
    return [...this.tarefas.values()].filter((t) => t.estado === 'ativa' || t.estado === 'pausada').map((t) => ({ ...t }))
  }

  async listTarefaRodadas(ids: string[], porTarefa: number): Promise<TarefaRodada[]> {
    this.check()
    const out: TarefaRodada[] = []
    for (const id of ids) out.push(...this.rodadas.filter((r) => r.tarefaId === id).sort((a, b) => b.inicio.localeCompare(a.inicio)).slice(0, porTarefa))
    return out
  }

  async insertTarefa(t: Tarefa): Promise<void> {
    this.check()
    if (!this.tarefas.has(t.id)) this.tarefas.set(t.id, { ...t, leaseDono: null, leaseToken: null, leaseAte: null })
  }

  async updateTarefaEstado(p: TarefaEstadoPatch): Promise<boolean> {
    this.check()
    const t = this.tarefas.get(p.id)
    if (!t) return false
    this.tarefas.set(p.id, { ...t, estado: p.estado, proximaEm: p.proximaEm, atualizadaEm: p.atualizadaEm })
    return true
  }

  async marcarTarefaVista(id: string): Promise<void> {
    this.check()
    const t = this.tarefas.get(id)
    if (t) this.tarefas.set(id, { ...t, bateuNaoVistoEm: null })
  }

  async cancelTarefasDaConversa(convId: string): Promise<number> {
    this.check()
    let n = 0
    for (const t of this.tarefas.values()) {
      if (t.convId !== convId || (t.estado !== 'ativa' && t.estado !== 'pausada')) continue
      this.tarefas.set(t.id, { ...t, estado: 'cancelada', proximaEm: null })
      n += 1
    }
    return n
  }

  async claimTarefa(c: TarefaClaim): Promise<boolean> {
    this.check()
    const t = this.tarefas.get(c.id)
    if (!t || t.estado !== 'ativa' || t.proximaEm === null) return false
    const cortesia = t.criadaPor === c.dono ? 0 : c.cortesiaMs
    if (Date.parse(t.proximaEm) > c.agora - cortesia) return false
    if (t.leaseToken && t.leaseAte !== null && t.leaseAte >= c.agora && t.leaseDono !== c.dono) return false
    this.tarefas.set(c.id, { ...t, leaseDono: c.dono, leaseToken: c.token, leaseAte: c.agora + c.ttlMs })
    return true
  }

  async renewTarefaLease(id: string, token: string, ate: number): Promise<boolean> {
    this.check()
    const t = this.tarefas.get(id)
    if (!t || t.leaseToken !== token) return false
    this.tarefas.set(id, { ...t, leaseAte: ate })
    return true
  }

  async releaseTarefaLease(id: string, token: string): Promise<void> {
    this.check()
    const t = this.tarefas.get(id)
    if (t && t.leaseToken === token) this.tarefas.set(id, { ...t, leaseDono: null, leaseToken: null, leaseAte: null })
  }

  async finishTarefaRodada(f: TarefaFimRodada): Promise<boolean> {
    this.check()
    const t = this.tarefas.get(f.id)
    if (!t) return false
    const minha = t.leaseToken === f.token
    const livre = !t.leaseToken || (t.leaseAte !== null && t.leaseAte < f.agora)
    const maisNova = t.ultimaEm !== null && Date.parse(t.ultimaEm) >= f.inicio
    if (!minha && !(livre && !maisNova)) return false
    const { concluir, ...campos } = f.campos
    this.tarefas.set(f.id, {
      ...t, ...campos, estado: concluir && t.estado === 'ativa' ? 'concluida' : t.estado, leaseDono: null, leaseToken: null, leaseAte: null
    })
    this.rodadas.push(...f.rodadas)
    return true
  }

  /** Outro PC "rouba" a trava (para o teste de perda). */
  roubarTrava(id: string, dono: string): void {
    const t = this.tarefas.get(id)
    if (t) this.tarefas.set(id, { ...t, leaseDono: dono, leaseToken: `roubado-${dono}`, leaseAte: Date.now() + 600_000 })
  }
}
