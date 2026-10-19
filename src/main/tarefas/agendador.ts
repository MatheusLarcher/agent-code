import { randomUUID } from 'node:crypto'
import { TAREFA_RODADAS_GUARDADAS, type TarefaRodada } from '../../shared/tarefas'
import type { TarefaRegistro, TarefaRepository } from '../persistence/tarefaTypes'
import { decidirAposRodada, intervaloMs, timeoutDaRodada, type AvisoTarefa, type MensagemTarefa, type ResultadoRodada } from './regras'
import type { TarefaStore } from './store'

/**
 * O agendador das tarefas: UM timer no main, armado para a próxima vencida (no
 * máximo 1 min, quando relê o banco para ver o outro PC). Cada rodada pega a
 * trava da tarefa no banco (60 s, renovada a cada 20 s; quem criou tem a
 * prioridade): só uma instalação roda. Sem sobreposição, no máximo 2 monitores
 * ao mesmo tempo, teto de tempo por rodada. Vencida (PC dormiu, app fechado)
 * roda UMA vez: a seguinte sai do fim desta. Nada aqui lança para fora.
 */

export const TRAVA_MS = 60_000
export const RENOVA_MS = 20_000
/** Quem não criou a tarefa espera isto de atraso antes de assumir. */
export const CORTESIA_MS = 60_000
/** De quanto em quanto tempo relê o banco (o que o outro PC criou/mudou). */
export const RECARGA_MS = 60_000
/** Trava recusada (outro PC rodando): tenta de novo depois disso. */
const ADIA_MS = 15_000
const MIN_TIMER_MS = 500

export interface ContextoRodada {
  signal: AbortSignal
  atrasadaMs: number
  timeoutMs: number
}

export type Executor = (t: TarefaRegistro, ctx: ContextoRodada) => Promise<ResultadoRodada>

export interface AgendadorDeps {
  store: TarefaStore
  repository(): TarefaRepository | null
  instalacao(): string
  agora?(): number
  /** Lembrete: sem LLM, só dispara (padrão). */
  executarLembrete?: Executor
  executarMonitor: Executor
  avisar(aviso: AvisoTarefa): void
  mensagem?(m: MensagemTarefa): void
  maxMonitores?: number
  log?(line: string): void
}

interface Rodando {
  controller: AbortController
  token: string
  inicio: number
  confirmada: boolean
  pulou: boolean
  motivo: 'timeout' | 'trava perdida' | 'pausada' | 'cancelada' | 'app fechando' | null
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const iso = (ms: number): string => new Date(ms).toISOString()

export class Agendador {
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly rodando = new Map<string, Rodando>()
  private readonly adiadas = new Map<string, number>()
  private ultimaRecarga = Number.NEGATIVE_INFINITY
  private parado = true
  private emCurso: Promise<void> | null = null
  private outroTick = false
  private readonly agora: () => number

  constructor(private readonly deps: AgendadorDeps) {
    this.agora = deps.agora ?? (() => Date.now())
    // Criada/retomada só vira "vencida" depois de chegar ao banco (a trava é lá).
    deps.store.aoGravar(() => this.reagendar())
  }

  iniciar(): void {
    if (!this.parado) return
    this.parado = false
    void this.tick(true)
  }

  /** Fechamento: para o timer e aborta as rodadas em andamento (o CLI delas morre junto). */
  parar(): void {
    this.parado = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const r of this.rodando.values()) {
      r.motivo = 'app fechando'
      r.controller.abort()
    }
  }

  /** Acordou do sono / desbloqueou: relê e roda as vencidas (uma vez cada). */
  acordar(): void {
    void this.tick(true)
  }

  /** Algo mudou (criou, pausou, retomou): recalcula o timer já. */
  reagendar(): void {
    void this.tick(false)
  }

  /** Pausar/cancelar com a rodada no meio: aborta e não grava o resultado. */
  abortar(id: string, motivo: 'pausada' | 'cancelada'): void {
    const r = this.rodando.get(id)
    if (!r) return
    r.motivo = motivo
    r.controller.abort()
  }

  estaRodando(id: string): boolean {
    return this.rodando.get(id)?.confirmada === true
  }

  monitoresRodando(): number {
    let n = 0
    for (const [id] of this.rodando) if (this.deps.store.get(id)?.tipo === 'monitor') n += 1
    return n
  }

  private async tick(recarregar: boolean): Promise<void> {
    if (this.parado) return
    if (this.emCurso) {
      this.outroTick = true
      return this.emCurso
    }
    const work = this.passo(recarregar).catch((error) => this.deps.log?.(`[tarefas] agendador: ${message(error)}`))
    this.emCurso = work.finally(() => {
      this.emCurso = null
      if (this.outroTick) {
        this.outroTick = false
        void this.tick(false)
      } else this.armar()
    })
    return this.emCurso
  }

  private async passo(recarregar: boolean): Promise<void> {
    const agora = this.agora()
    if (recarregar || agora - this.ultimaRecarga >= RECARGA_MS) {
      this.ultimaRecarga = agora
      if (await this.deps.store.recarregar()) this.adiadas.clear()
    }
    const max = this.deps.maxMonitores ?? 2
    for (const t of this.vencidas(this.agora())) {
      const rodando = this.rodando.get(t.id)
      if (rodando) {
        // A seguinte chegou com esta ainda rodando: pula (fica registrada no fim desta).
        if (rodando.confirmada && this.agora() - rodando.inicio >= intervaloMs(t.agenda)) rodando.pulou = true
        continue
      }
      if (t.tipo === 'monitor' && this.monitoresRodando() >= max) continue
      void this.rodar(t)
    }
  }

  /** Ativas, vencidas para esta instalação (a criadora na hora; as outras, depois da cortesia). */
  private vencidas(agora: number): TarefaRegistro[] {
    const eu = this.deps.instalacao()
    return this.deps.store
      .lista()
      .filter(
        (t) =>
          t.estado === 'ativa' && t.proximaEm !== null && !this.deps.store.temPendente(t.id) &&
          this.venceEm(t, eu) <= agora && (this.adiadas.get(t.id) ?? 0) <= agora
      )
      .sort((a, b) => Date.parse(a.proximaEm!) - Date.parse(b.proximaEm!))
  }

  private venceEm(t: TarefaRegistro, eu: string): number {
    return Date.parse(t.proximaEm!) + (t.criadaPor === eu ? 0 : CORTESIA_MS)
  }

  private armar(): void {
    if (this.parado) return
    if (this.timer) clearTimeout(this.timer)
    const agora = this.agora()
    const eu = this.deps.instalacao()
    let proxima = this.ultimaRecarga + RECARGA_MS
    for (const t of this.deps.store.lista()) {
      // Com gravação na fila: quem destrava é o `aoGravar`.
      if (t.estado !== 'ativa' || t.proximaEm === null || this.rodando.has(t.id) || this.deps.store.temPendente(t.id)) continue
      const vence = Math.max(this.venceEm(t, eu), this.adiadas.get(t.id) ?? 0)
      // Vencida esperando vaga de monitor: quem destrava é o fim de uma rodada.
      if (vence <= agora && t.tipo === 'monitor' && this.monitoresRodando() >= (this.deps.maxMonitores ?? 2)) continue
      proxima = Math.min(proxima, vence)
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick(false)
    }, Math.max(MIN_TIMER_MS, proxima - agora))
    this.timer.unref?.()
  }

  private async rodar(t: TarefaRegistro): Promise<void> {
    const r: Rodando = { controller: new AbortController(), token: randomUUID(), inicio: this.agora(), confirmada: false, pulou: false, motivo: null }
    this.rodando.set(t.id, r)
    const eu = this.deps.instalacao()
    let renovar: ReturnType<typeof setInterval> | null = null
    let prazo: ReturnType<typeof setTimeout> | null = null
    try {
      const repo = this.deps.repository()
      const pegou = repo
        ? await repo
            .claimTarefa({ id: t.id, dono: eu, token: r.token, agora: r.inicio, ttlMs: TRAVA_MS, cortesiaMs: CORTESIA_MS })
            .catch((error) => {
              this.deps.log?.(`[tarefas] trava de ${t.id} falhou: ${message(error)}`)
              return false
            })
        : false
      if (!pegou || this.parado || r.motivo) {
        if (pegou && repo) await repo.releaseTarefaLease(t.id, r.token).catch(() => undefined)
        this.adiadas.set(t.id, this.agora() + ADIA_MS)
        return
      }
      r.confirmada = true
      this.deps.store.avisarMudanca()
      renovar = setInterval(() => void this.renovar(t.id, r), RENOVA_MS)
      renovar.unref?.()
      const timeoutMs = timeoutDaRodada(t)
      prazo = setTimeout(() => {
        r.motivo ??= 'timeout'
        r.controller.abort()
      }, timeoutMs)
      prazo.unref?.()
      const atrasadaMs = Math.max(0, r.inicio - Date.parse(t.proximaEm ?? iso(r.inicio)))
      const executar = t.tipo === 'monitor' ? this.deps.executarMonitor : (this.deps.executarLembrete ?? (async () => ({ resultado: 'disparado' as const })))
      let resultado: ResultadoRodada
      try {
        resultado = await executar(t, { signal: r.controller.signal, atrasadaMs, timeoutMs })
      } catch (error) {
        resultado = { resultado: 'falha', falha: message(error) }
      }
      if (r.motivo === 'timeout') resultado = { resultado: 'falha', falha: `passou de ${Math.round(timeoutMs / 60_000) || 1} min sem terminar` }
      clearInterval(renovar)
      renovar = null
      clearTimeout(prazo)
      prazo = null
      if (r.motivo && r.motivo !== 'timeout') {
        // Pausada/cancelada/fechando: solta a trava sem gravar. Trava perdida: o outro PC assumiu.
        if (r.motivo !== 'trava perdida' && repo) await repo.releaseTarefaLease(t.id, r.token).catch(() => undefined)
        this.deps.log?.(`[tarefas] rodada de ${t.id} interrompida (${r.motivo})`)
        return
      }
      await this.concluir(t, r, resultado, atrasadaMs)
    } catch (error) {
      this.deps.log?.(`[tarefas] rodada de ${t.id} falhou fora do executor: ${message(error)}`)
    } finally {
      if (renovar) clearInterval(renovar)
      if (prazo) clearTimeout(prazo)
      this.rodando.delete(t.id)
      this.deps.store.avisarMudanca()
      this.reagendar()
    }
  }

  private async renovar(id: string, r: Rodando): Promise<void> {
    const repo = this.deps.repository()
    if (!repo || r.motivo) return
    const ok = await repo.renewTarefaLease(id, r.token, this.agora() + TRAVA_MS).catch((error) => {
      // Banco caído: segue rodando (não dá para saber); a trava vence sozinha se a queda durar.
      this.deps.log?.(`[tarefas] renovar a trava de ${id} falhou: ${message(error)}`)
      return null
    })
    if (ok === false && !r.motivo) {
      r.motivo = 'trava perdida'
      r.controller.abort()
    }
  }

  private async concluir(t: TarefaRegistro, r: Rodando, resultado: ResultadoRodada, atrasadaMs: number): Promise<void> {
    const fim = this.agora()
    const atual = this.deps.store.get(t.id) ?? t
    const decisao = decidirAposRodada(atual, resultado, { agora: fim, atrasadaMs })
    const eu = this.deps.instalacao()
    const rodadas: TarefaRodada[] = [
      {
        id: randomUUID(), tarefaId: t.id, inicio: iso(r.inicio), fim: iso(fim), resultado: resultado.resultado,
        valor: resultado.valor ?? null, resumo: resultado.resumo ?? null, fonte: resultado.fonte ?? null, falha: resultado.falha ?? null, instalacao: eu
      }
    ]
    if (r.pulou) {
      rodadas.push({ id: randomUUID(), tarefaId: t.id, inicio: iso(fim), fim: iso(fim), resultado: 'pulada', valor: null, resumo: null, fonte: null, falha: 'a anterior ainda rodava', instalacao: eu })
    }
    const pedido = { id: t.id, token: r.token, inicio: r.inicio, agora: fim, rodadas, campos: decisao.campos, guardar: TAREFA_RODADAS_GUARDADAS }
    const repo = this.deps.repository()
    let gravou: boolean | null = null
    try {
      gravou = repo ? await repo.finishTarefaRodada(pedido) : null
    } catch (error) {
      this.deps.log?.(`[tarefas] gravar a rodada de ${t.id} falhou, nova tentativa pela fila: ${message(error)}`)
    }
    if (gravou === false) {
      // Outra instalação rodou depois: o resultado dela vale; não avisa duas vezes.
      this.deps.log?.(`[tarefas] rodada de ${t.id} descartada (outra instalação rodou depois)`)
      this.ultimaRecarga = Number.NEGATIVE_INFINITY
      return
    }
    if (gravou === null) this.deps.store.regravarFim(pedido)
    this.deps.store.aplicarRodada(t.id, decisao.campos, rodadas)
    for (const aviso of decisao.avisos) this.chamar(() => this.deps.avisar(aviso), 'aviso')
    if (decisao.mensagem) {
      const m = decisao.mensagem
      this.chamar(() => this.deps.mensagem?.(m), 'mensagem')
    }
  }

  private chamar(fn: () => void, rotulo: string): void {
    try {
      fn()
    } catch (error) {
      this.deps.log?.(`[tarefas] ${rotulo} falhou: ${message(error)}`)
    }
  }
}
