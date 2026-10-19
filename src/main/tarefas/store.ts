import { TAREFA_RODADAS_VISTAS, type Tarefa, type TarefaEstado, type TarefaRodada } from '../../shared/tarefas'
import { isTransientPostgresError } from '../persistence/postgresRetry'
import { StorageError } from '../persistence/types'
import type { TarefaCamposRodada, TarefaFimRodada, TarefaRegistro, TarefaRepository } from '../persistence/tarefaTypes'

/**
 * As tarefas na memória do main, com o banco por trás. A tela e o agendador leem
 * daqui (nunca esperam o banco); criar, pausar, retomar, cancelar e "visto" mudam
 * a memória na hora e entram numa fila que grava em ordem, com nova tentativa
 * quando o banco cai (as mesmas esperas da fila de gravação do main). A releitura
 * periódica traz o que o outro PC mudou — sem passar por cima do que ainda está
 * na fila daqui.
 */

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

/** `ids`: as tarefas que a gravação toca — a releitura não passa por cima delas. */
type Job = { ids: string[]; run: (repo: TarefaRepository) => Promise<unknown>; falhas: number; rotulo: string }

export interface TarefaStoreDeps {
  repository(): TarefaRepository | null
  log?(line: string): void
}

function retryable(error: unknown): boolean {
  return error instanceof StorageError ? error.retryable : isTransientPostgresError(error)
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class TarefaStore {
  private readonly tarefas = new Map<string, TarefaRegistro>()
  private readonly rodadas = new Map<string, TarefaRodada[]>()
  private readonly fila: Job[] = []
  private readonly listeners = new Set<() => void>()
  private readonly aoGravarFns = new Set<() => void>()
  private gravando: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Espera antes da próxima tentativa (0 = sem falha pendente). */
  private espera = 0
  private descartada = false

  constructor(private readonly deps: TarefaStoreDeps) {}

  /** Todas na memória (inclusive as recém-canceladas/concluídas ainda a caminho do banco). */
  lista(): TarefaRegistro[] {
    return [...this.tarefas.values()]
  }

  get(id: string): TarefaRegistro | undefined {
    return this.tarefas.get(id)
  }

  rodadasDe(id: string): TarefaRodada[] {
    return this.rodadas.get(id) ?? []
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Uma gravação da fila chegou ao banco (o agendador recalcula: a tarefa já pode ser travada). */
  aoGravar(fn: () => void): () => void {
    this.aoGravarFns.add(fn)
    return () => this.aoGravarFns.delete(fn)
  }

  /** A tarefa tem gravação na fila: ainda não está (como está aqui) no banco. */
  temPendente(id: string): boolean {
    return this.fila.some((job) => job.ids.includes(id))
  }

  /** Aviso de mudança ao vivo (ex.: a rodada começou). Nunca lança. */
  avisarMudanca(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch (error) {
        this.deps.log?.(`[tarefas] ouvinte falhou: ${message(error)}`)
      }
    }
  }

  /**
   * Relê o banco. A tarefa com gravação na fila fica com a versão daqui; a que
   * sumiu do banco (concluída/cancelada no outro PC) sai. `false` = sem banco ou
   * erro (a memória fica como estava).
   */
  async recarregar(): Promise<boolean> {
    const repo = this.deps.repository()
    if (!repo) return false
    try {
      const doBanco = await repo.listTarefas()
      const rodadas = await repo.listTarefaRodadas(doBanco.map((t) => t.id), TAREFA_RODADAS_VISTAS)
      const naFila = new Set(this.fila.flatMap((job) => job.ids))
      const vistos = new Set<string>()
      for (const t of doBanco) {
        vistos.add(t.id)
        if (!naFila.has(t.id)) this.tarefas.set(t.id, t)
      }
      for (const id of [...this.tarefas.keys()]) if (!vistos.has(id) && !naFila.has(id)) this.tarefas.delete(id)
      const porTarefa = new Map<string, TarefaRodada[]>()
      for (const r of rodadas) porTarefa.set(r.tarefaId, [...(porTarefa.get(r.tarefaId) ?? []), r])
      this.rodadas.clear()
      for (const [id, lista] of porTarefa) if (this.tarefas.has(id)) this.rodadas.set(id, lista)
      this.avisarMudanca()
      return true
    } catch (error) {
      this.deps.log?.(`[tarefas] releitura falhou: ${message(error)}`)
      return false
    }
  }

  criar(tarefa: Tarefa): TarefaRegistro {
    const registro: TarefaRegistro = { ...tarefa, leaseDono: null, leaseToken: null, leaseAte: null }
    this.tarefas.set(tarefa.id, registro)
    this.enfileirar([tarefa.id], 'criar', (repo) => repo.insertTarefa(tarefa))
    this.avisarMudanca()
    return registro
  }

  mudarEstado(id: string, estado: TarefaEstado, proximaEm: string | null, agora: number): TarefaRegistro | null {
    const atual = this.tarefas.get(id)
    if (!atual) return null
    const atualizadaEm = new Date(agora).toISOString()
    const novo: TarefaRegistro = { ...atual, estado, proximaEm, atualizadaEm, falhasSeguidas: estado === 'ativa' ? 0 : atual.falhasSeguidas }
    this.tarefas.set(id, novo)
    this.enfileirar([id], estado, (repo) => repo.updateTarefaEstado({ id, estado, proximaEm, atualizadaEm }))
    this.avisarMudanca()
    return novo
  }

  marcarVisto(id: string, agora: number): void {
    const atual = this.tarefas.get(id)
    if (!atual?.bateuNaoVistoEm) return
    const atualizadaEm = new Date(agora).toISOString()
    this.tarefas.set(id, { ...atual, bateuNaoVistoEm: null, atualizadaEm })
    this.enfileirar([id], 'visto', (repo) => repo.marcarTarefaVista(id, atualizadaEm))
    this.avisarMudanca()
  }

  /** Conversa apagada: as tarefas dela viram canceladas (a do banco também, mesmo a não lida ainda). */
  cancelarDaConversa(convId: string, agora: number): string[] {
    const atualizadaEm = new Date(agora).toISOString()
    const ids: string[] = []
    for (const t of this.tarefas.values()) {
      if (t.convId !== convId || (t.estado !== 'ativa' && t.estado !== 'pausada')) continue
      this.tarefas.set(t.id, { ...t, estado: 'cancelada', proximaEm: null, atualizadaEm })
      ids.push(t.id)
    }
    this.enfileirar(ids, `cancelar conversa ${convId}`, (repo) => repo.cancelTarefasDaConversa(convId, atualizadaEm))
    this.avisarMudanca()
    return ids
  }

  /** O fim de uma rodada já gravado (ou a caminho): só a memória. */
  aplicarRodada(id: string, campos: TarefaCamposRodada, rodadas: TarefaRodada[]): void {
    const atual = this.tarefas.get(id)
    if (atual) {
      const { concluir, ...resto } = campos
      this.tarefas.set(id, {
        ...atual,
        ...resto,
        estado: concluir && atual.estado === 'ativa' ? 'concluida' : atual.estado,
        leaseDono: null,
        leaseToken: null,
        leaseAte: null
      })
    }
    this.rodadas.set(id, [...rodadas].reverse().concat(this.rodadasDe(id)).slice(0, TAREFA_RODADAS_VISTAS))
    this.avisarMudanca()
  }

  /** O fim da rodada que o banco não recebeu (caiu): tenta de novo pela fila. */
  regravarFim(fim: TarefaFimRodada): void {
    this.enfileirar([fim.id], 'fim da rodada', (repo) => repo.finishTarefaRodada(fim))
  }

  pendentes(): number {
    return this.fila.length
  }

  /** Fechamento: grava já, esperando no máximo `deadlineMs`. `true` = fila vazia. */
  async flush(deadlineMs: number): Promise<boolean> {
    const limite = Date.now() + deadlineMs
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    while (this.fila.length && Date.now() < limite && this.deps.repository()) {
      const cabeca = this.fila[0]
      let espera: ReturnType<typeof setTimeout> | undefined
      await Promise.race([this.drenar(), new Promise<void>((resolve) => (espera = setTimeout(resolve, Math.max(0, limite - Date.now()))))])
      if (espera) clearTimeout(espera)
      if (this.fila[0] === cabeca) break // a cabeça não gravou (banco caído): não insiste no fechamento
    }
    return this.fila.length === 0
  }

  descartar(): void {
    this.descartada = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private enfileirar(ids: string[], rotulo: string, run: Job['run']): void {
    this.fila.push({ ids, rotulo, run, falhas: 0 })
    this.agendar(0)
  }

  private agendar(delay: number): void {
    if (this.descartada || this.gravando || this.timer || !this.fila.length) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.drenar()
    }, delay)
    this.timer.unref?.()
  }

  private drenar(): Promise<void> {
    if (this.gravando) return this.gravando
    const work = this.gravarEmOrdem().finally(() => {
      this.gravando = null
      // O que sobrou (banco caído) volta depois da espera da tentativa.
      const espera = this.espera
      this.espera = 0
      this.agendar(espera)
    })
    this.gravando = work
    return work
  }

  private async gravarEmOrdem(): Promise<void> {
    while (this.fila.length && !this.descartada) {
      const job = this.fila[0]
      const repo = this.deps.repository()
      if (!repo) return this.tentarDepois(job)
      try {
        await job.run(repo)
        this.fila.shift()
        for (const fn of this.aoGravarFns) {
          try {
            fn()
          } catch {
            // ouvinte com defeito não segura a fila
          }
        }
      } catch (error) {
        if (!retryable(error)) {
          this.fila.shift()
          this.deps.log?.(`[tarefas] gravação recusada (${job.rotulo} ${job.ids.join(',')}): ${message(error)}`)
          continue
        }
        this.deps.log?.(`[tarefas] banco indisponível, nova tentativa (${job.rotulo} ${job.ids.join(',')}): ${message(error)}`)
        return this.tentarDepois(job)
      }
    }
  }

  private tentarDepois(job: Job): void {
    job.falhas += 1
    this.espera = RETRY_DELAYS_MS[Math.min(job.falhas - 1, RETRY_DELAYS_MS.length - 1)]
  }
}
