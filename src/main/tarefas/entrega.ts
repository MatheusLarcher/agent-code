import type { AvisoTarefa } from './regras'

/**
 * A entrega ÚNICA dos avisos das tarefas (lembrete, monitor que bateu, falhas,
 * "precisa de você", aviso imediato). No molde de `setupOfficeCalls` (index.ts):
 * a `Notification` do Electron fica viva até o clique/fechar (solta, o coletor
 * levaria o clique junto) e o clique revela a janela e abre a conversa de origem.
 * Para onde vai é uma escolha plugável (`destino`): hoje sempre o Windows; o
 * celular entra pelo mesmo ponto. Nada aqui lança.
 */

export interface NotificacaoLike {
  on(event: 'click' | 'close' | 'failed', fn: () => void): unknown
  show(): void
}

export type DestinoAviso = 'windows' | 'celular' | 'ambos'

export interface EntregaDeps {
  suportado(): boolean
  criar(opcoes: { title: string; body: string }): NotificacaoLike
  /** Clique: revela a janela e abre a conversa. */
  abrir(convId: string): void
  /** A escolha do destino (padrão: Windows). */
  destino?(aviso: AvisoTarefa): DestinoAviso
  /** O envio ao celular, quando o destino o inclui. */
  celular?(aviso: AvisoTarefa): void
  log?(line: string): void
}

const TITULO_MAX = 64
const CORPO_MAX = 180

/** Corta no limite com reticências, sem quebrar no meio de palavra quando dá. */
export function curto(texto: string, max: number): string {
  const limpo = texto.replace(/\s+/g, ' ').trim()
  if (limpo.length <= max) return limpo
  const corte = limpo.slice(0, max - 1)
  const espaco = corte.lastIndexOf(' ')
  return `${espaco > max * 0.6 ? corte.slice(0, espaco) : corte}…`
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export class EntregaAvisos {
  private readonly vivas = new Set<NotificacaoLike>()

  constructor(private readonly deps: EntregaDeps) {}

  entregar(aviso: AvisoTarefa): void {
    let destino: DestinoAviso = 'windows'
    try {
      destino = this.deps.destino?.(aviso) ?? 'windows'
    } catch (error) {
      this.deps.log?.(`[avisos] escolha do destino falhou (vai ao Windows): ${message(error)}`)
    }
    if (destino !== 'celular') this.windows(aviso)
    if (destino !== 'windows') {
      try {
        this.deps.celular?.(aviso)
      } catch (error) {
        this.deps.log?.(`[avisos] envio ao celular falhou: ${message(error)}`)
      }
    }
  }

  /** Quantas notificações ainda esperam clique/fechar (teste e diagnóstico). */
  pendentes(): number {
    return this.vivas.size
  }

  private windows(aviso: AvisoTarefa): void {
    try {
      if (!this.deps.suportado()) {
        this.deps.log?.(`[avisos] notificação do Windows indisponível: "${aviso.titulo}"`)
        return
      }
      const n = this.deps.criar({ title: curto(aviso.titulo, TITULO_MAX), body: curto(aviso.texto, CORPO_MAX) })
      const soltar = (): void => void this.vivas.delete(n)
      this.vivas.add(n)
      n.on('click', () => {
        soltar()
        try {
          this.deps.abrir(aviso.convId)
        } catch (error) {
          this.deps.log?.(`[avisos] abrir a conversa falhou: ${message(error)}`)
        }
      })
      n.on('close', soltar)
      n.on('failed', () => {
        soltar()
        this.deps.log?.(`[avisos] o Windows recusou a notificação "${aviso.titulo}"`)
      })
      n.show()
    } catch (error) {
      this.deps.log?.(`[avisos] notificação falhou: ${message(error)}`)
    }
  }
}
