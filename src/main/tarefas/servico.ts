import { randomUUID } from 'node:crypto'
import {
  tarefaVisivel,
  validarTarefaAcao,
  validarTarefaNova,
  type TarefaVista,
  type Validado
} from '../../shared/tarefas'
import type { TarefaRegistro, TarefaRepository } from '../persistence/tarefaTypes'
import { Agendador, type Executor } from './agendador'
import { novaTarefa, proximaAoRetomar, type AvisoTarefa, type MensagemTarefa } from './regras'
import { TarefaStore } from './store'

/**
 * A porta única das tarefas no main: o MCP `avisos` (chat), o IPC da tela e a
 * rota do celular passam por aqui. Junta a memória (store), o agendador e a
 * entrega do aviso. Nenhum método lança: entrada torta volta como `{ ok: false }`.
 */

export interface TarefasServicoDeps {
  repository(): TarefaRepository | null
  instalacao(): string
  executarMonitor: Executor
  avisar(aviso: AvisoTarefa): void
  mensagem?(m: MensagemTarefa): void
  agora?(): number
  log?(line: string): void
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class TarefasServico {
  readonly store: TarefaStore
  readonly agendador: Agendador
  private readonly agora: () => number

  constructor(private readonly deps: TarefasServicoDeps) {
    this.agora = deps.agora ?? (() => Date.now())
    this.store = new TarefaStore({ repository: deps.repository, log: deps.log })
    this.agendador = new Agendador({
      store: this.store,
      repository: deps.repository,
      instalacao: deps.instalacao,
      agora: this.agora,
      executarMonitor: deps.executarMonitor,
      avisar: deps.avisar,
      mensagem: deps.mensagem,
      log: deps.log
    })
  }

  iniciar(): void {
    this.agendador.iniciar()
  }

  parar(): void {
    this.agendador.parar()
  }

  /** PC acordou / desbloqueou: roda as vencidas, uma vez cada. */
  acordar(): void {
    this.agendador.acordar()
  }

  onChange(fn: () => void): () => void {
    return this.store.onChange(fn)
  }

  /** Cria a tarefa (já validada na fronteira). */
  criar(raw: unknown): Validado<TarefaVista> {
    const pedido = validarTarefaNova(raw)
    if (!pedido.ok) return pedido
    const tarefa = novaTarefa(pedido.valor, { id: randomUUID(), agora: this.agora(), instalacao: this.deps.instalacao() })
    if (!tarefa.ok) return tarefa
    const registro = this.store.criar(tarefa.valor)
    this.agendador.reagendar()
    return { ok: true, valor: this.vista(registro) }
  }

  /** As visíveis (ativas e pausadas), de uma conversa ou de todas. */
  vistas(convId?: string): TarefaVista[] {
    return this.store
      .lista()
      .filter((t) => tarefaVisivel(t) && (convId === undefined || t.convId === convId))
      .map((t) => this.vista(t))
  }

  temAtiva(): boolean {
    return this.store.lista().some((t) => t.estado === 'ativa')
  }

  /** Pausar, retomar, cancelar ou marcar o "bateu" como visto. `convId`: só tarefa dessa conversa. */
  acao(raw: unknown, convId?: string): Validado<TarefaVista | null> {
    const pedido = validarTarefaAcao(raw)
    if (!pedido.ok) return pedido
    const { id, acao } = pedido.valor
    const t = this.store.get(id)
    if (!t || !tarefaVisivel(t)) return { ok: false, erro: `não existe tarefa ativa ou pausada com id ${id}` }
    if (convId !== undefined && t.convId !== convId) return { ok: false, erro: `a tarefa ${id} é de outra conversa` }
    const agora = this.agora()
    try {
      if (acao === 'visto') {
        this.store.marcarVisto(id, agora)
      } else if (acao === 'pausar') {
        if (t.estado !== 'ativa') return { ok: false, erro: 'a tarefa já está pausada' }
        this.store.mudarEstado(id, 'pausada', null, agora)
        this.agendador.abortar(id, 'pausada')
      } else if (acao === 'retomar') {
        if (t.estado !== 'pausada') return { ok: false, erro: 'a tarefa não está pausada' }
        this.store.mudarEstado(id, 'ativa', new Date(proximaAoRetomar(t, agora)).toISOString(), agora)
      } else {
        this.store.mudarEstado(id, 'cancelada', null, agora)
        this.agendador.abortar(id, 'cancelada')
      }
      this.agendador.reagendar()
      const depois = this.store.get(id)
      return { ok: true, valor: depois && tarefaVisivel(depois) ? this.vista(depois) : null }
    } catch (error) {
      this.deps.log?.(`[tarefas] ação ${acao} em ${id} falhou: ${message(error)}`)
      return { ok: false, erro: message(error) }
    }
  }

  /** Aviso imediato (`aviso_notificar`), sem tarefa. */
  notificarAgora(convId: string, titulo: string, texto: string): void {
    try {
      this.deps.avisar({ tipo: 'agora', convId, tarefaId: null, titulo, texto })
    } catch (error) {
      this.deps.log?.(`[tarefas] aviso imediato falhou: ${message(error)}`)
    }
  }

  /** Conversa apagada: as tarefas dela são canceladas (e a rodada no meio, abortada). */
  conversaApagada(convId: string): void {
    try {
      for (const id of this.store.cancelarDaConversa(convId, this.agora())) this.agendador.abortar(id, 'cancelada')
      this.agendador.reagendar()
    } catch (error) {
      this.deps.log?.(`[tarefas] cancelar as tarefas de ${convId} falhou: ${message(error)}`)
    }
  }

  flush(deadlineMs: number): Promise<boolean> {
    return this.store.flush(deadlineMs).catch(() => false)
  }

  private vista(t: TarefaRegistro): TarefaVista {
    const { leaseDono, leaseToken: _token, leaseAte, ...tarefa } = t
    const noOutroPc = leaseAte !== null && leaseAte > this.agora() && leaseDono !== this.deps.instalacao()
    return { ...tarefa, rodando: this.agendador.estaRodando(t.id) || noOutroPc, rodadas: this.store.rodadasDe(t.id) }
  }
}
