import { Channels } from '../../shared/ipc'
import type { TarefaVista } from '../../shared/tarefas'
import type { TarefaRepository } from '../persistence/tarefaTypes'
import type { Executor } from './agendador'
import { EntregaAvisos, type EntregaDeps, type NotificacaoLike } from './entrega'
import type { MensagemTarefa } from './regras'
import { configureTarefasRuntime } from './runtime'
import { TarefasServico } from './servico'

/**
 * A ligação das tarefas no app (chamada uma vez pelo index.ts): a entrega dos
 * avisos no Windows, o serviço publicado para as sessões (MCP `avisos`), o IPC
 * da tela e a mudança ao vivo. Recebe o Electron por dependência para o index.ts
 * ficar com uma linha só.
 */

export interface TarefasAppDeps {
  repository(): TarefaRepository | null
  instalacao(): string
  executarMonitor: Executor
  notificacao: { isSupported(): boolean; create(opcoes: { title: string; body: string }): NotificacaoLike }
  revelarJanela(): void
  send(channel: string, payload: unknown): void
  handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void
  mensagem?(m: MensagemTarefa): void
  /** Mudança na lista (a ponte do celular também quer saber). */
  mudou?(vistas: TarefaVista[]): void
  destino?: EntregaDeps['destino']
  celular?: EntregaDeps['celular']
  log(line: string): void
}

const COALESCE_MS = 120

export function setupTarefasApp(deps: TarefasAppDeps): { servico: TarefasServico; entrega: EntregaAvisos } {
  const entrega = new EntregaAvisos({
    suportado: () => deps.notificacao.isSupported(),
    criar: (opcoes) => deps.notificacao.create(opcoes),
    abrir: (convId) => {
      deps.revelarJanela()
      deps.send(Channels.tarefaAbrirConversa, { convId })
    },
    destino: deps.destino,
    celular: deps.celular,
    log: deps.log
  })
  const servico = new TarefasServico({
    repository: deps.repository,
    instalacao: deps.instalacao,
    executarMonitor: deps.executarMonitor,
    avisar: (aviso) => entrega.entregar(aviso),
    mensagem: deps.mensagem,
    log: deps.log
  })
  configureTarefasRuntime(servico)

  // Rajada de mudanças (rodada começou, gravou, terminou) vira um envio só.
  let timer: ReturnType<typeof setTimeout> | null = null
  servico.onChange(() => {
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      try {
        const vistas = servico.vistas()
        deps.send(Channels.tarefasChanged, vistas)
        deps.mudou?.(vistas)
      } catch (error) {
        deps.log(`[tarefas] aviso de mudança falhou: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, COALESCE_MS)
    timer.unref?.()
  })
  deps.handle(Channels.tarefasList, () => servico.vistas())
  deps.handle(Channels.tarefasAcao, (_event, raw) => servico.acao(raw))
  servico.iniciar()
  return { servico, entrega }
}
