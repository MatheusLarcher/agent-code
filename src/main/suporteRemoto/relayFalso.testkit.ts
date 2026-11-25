// Relay falso para os testes do suporte remoto: um `fetch` que responde como o
// broker/src/suporte.js (parear, eventos em SSE, encerrar) e deixa o teste mandar eventos,
// derrubar o fluxo e ver o que foi pedido. Nada sai para a rede.
import { SUPORTE_CABECALHO_CHAVE, type SuporteEvento } from '../../shared/suporteRemoto'

export const CHAVE_DE_TESTE = 'chave-de-teste-somente-para-o-relay-falso'
export const TOKEN_DE_TESTE = 'tok_' + 'a'.repeat(40)
export const SESSAO_DE_TESTE = 'sessaoDeTeste0001'

export interface PedidoVisto {
  metodo: string
  caminho: string
  chave?: string
  autorizacao?: string
  corpo?: unknown
}

export interface RelayFalso {
  fetchImpl: typeof fetch
  pedidos: PedidoVisto[]
  /** O que o próximo `parear` responde. Padrão: 200 com sessão e token de teste. */
  parear: { status: number; corpo: unknown; segurar?: boolean }
  /** Solta um `parear` que estava segurado (o cliente "decidiu"). */
  soltar(): void
  /** Manda um evento pelo fluxo SSE aberto. */
  emitir(evento: SuporteEvento): void
  /** Fecha o fluxo SSE (o relay caiu ou a rede cortou). */
  derrubar(): void
  /** Há um fluxo de eventos aberto agora? */
  ouvindo(): boolean
}

const json = (status: number, corpo: unknown): Response =>
  new Response(JSON.stringify(corpo), { status, headers: { 'content-type': 'application/json' } })

export function relayFalso(): RelayFalso {
  const codificador = new TextEncoder()
  let fluxo: ReadableStreamDefaultController<Uint8Array> | null = null
  let soltarParear: (() => void) | null = null
  const relay: RelayFalso = {
    pedidos: [],
    parear: {
      status: 200,
      corpo: {
        sessao: SESSAO_DE_TESTE,
        token: TOKEN_DE_TESTE,
        info: { pc: 'PC-DO-CLIENTE', sistema: 'windows', versaoSistema: '11', versao: '1.0.0', capacidades: ['tela', 'comandos'], admin: false }
      }
    },
    soltar: () => soltarParear?.(),
    emitir: (evento) => fluxo?.enqueue(codificador.encode(`data: ${JSON.stringify(evento)}\n\n`)),
    derrubar: () => {
      try {
        fluxo?.close()
      } catch {
        /* já fechado */
      }
      fluxo = null
    },
    ouvindo: () => fluxo !== null,
    fetchImpl: (async (entrada: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(entrada))
      const cabecalhos = new Headers(init?.headers)
      const pedido: PedidoVisto = {
        metodo: init?.method ?? 'GET',
        caminho: url.pathname,
        chave: cabecalhos.get(SUPORTE_CABECALHO_CHAVE) ?? undefined,
        autorizacao: cabecalhos.get('authorization') ?? undefined,
        corpo: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      }
      relay.pedidos.push(pedido)
      const sinal = init?.signal ?? undefined
      if (url.pathname === '/suporte/parear') {
        if (relay.parear.segurar) {
          await new Promise<void>((ok, falha) => {
            soltarParear = ok
            sinal?.addEventListener('abort', () => falha(new DOMException('aborted', 'AbortError')))
          })
        }
        return json(relay.parear.status, relay.parear.corpo)
      }
      if (url.pathname.startsWith('/suporte/eventos/')) {
        const corpo = new ReadableStream<Uint8Array>({
          start(controle) {
            fluxo = controle
            controle.enqueue(codificador.encode(`data: ${JSON.stringify({ evento: 'conectado', admin: false })}\n\n`))
            sinal?.addEventListener('abort', () => {
              if (fluxo !== controle) return
              fluxo = null
              try {
                controle.error(new DOMException('aborted', 'AbortError'))
              } catch {
                /* já fechado */
              }
            })
          }
        })
        return new Response(corpo, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.pathname.startsWith('/suporte/encerrar/')) return json(200, { ok: true })
      return json(404, { erro: 'rota' })
    }) as typeof fetch
  }
  return relay
}

/** Espera uma condição ficar verdadeira (os eventos chegam em microtarefas do fluxo). */
export async function ate(condicao: () => boolean, prazoMs = 2000): Promise<void> {
  const fim = Date.now() + prazoMs
  while (!condicao()) {
    if (Date.now() > fim) throw new Error('tempo esgotado esperando a condição do teste')
    await new Promise((ok) => setTimeout(ok, 5))
  }
}
