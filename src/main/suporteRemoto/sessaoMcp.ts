// Liga a sessão do agente de UMA conversa ao suporte remoto: o servidor interno `suporte`
// existe só com o recurso ativado, e o `remoto` (o exe do cliente, por http no relay)
// entra e sai por `setMcpServers`, só na conversa que conectou.
//
// Sonda ao vivo de 25/11/2026 (SDK 0.3.332, conta real): `setMcpServers` liga um servidor
// http no meio da conversa e até no meio do turno (a ferramenta nova já serve na mesma
// resposta), e tirar o servidor some com a ferramenta na hora. Mas a chamada SUBSTITUI
// todos os servidores internos do SDK: quem não for repassado é desligado. Por isso cada
// troca reenvia os internos montados no start() da sessão. Os stdio/http das opções
// (rea, MCP de entrada) não são tocados quando ficam de fora.
import type { McpServerConfig, McpSetServersResult } from '@anthropic-ai/claude-agent-sdk'
import { SUPORTE_SERVIDOR_INTERNO, SUPORTE_SERVIDOR_REMOTO } from '../../shared/suporteRemoto'
import type { SuporteRemotoServico } from './servico'

export interface LigacaoDeps {
  convId: string
  servico: SuporteRemotoServico
  /** Os servidores com que a sessão subiu (o mesmo objeto de `options.mcpServers`). */
  base: Record<string, McpServerConfig>
  /** A consulta viva do SDK, ou null se a sessão já fechou. */
  consulta: () => { setMcpServers(servidores: Record<string, McpServerConfig>): Promise<McpSetServersResult> } | null
  ativado: () => boolean
  /** Cria o servidor interno `suporte` desta conversa (só quando preciso). */
  servidorSuporte: () => McpServerConfig
  /** Falha ao ligar o servidor: vai ao chat, sem endereço nem token. */
  aoFalhar?: (texto: string) => void
  /** O que a sessão ligou depois de subir (rea, Android, Chrome sob demanda): toda troca os
   *  repete, senão conectar no cliente os derrubaria. */
  extras?: () => Record<string, McpServerConfig>
}

export interface LigacaoSuporte {
  /** Reaplica os servidores se o estado (interruptor, sessão) mudou. */
  aplicar(): Promise<void>
  /** O `suporte` e o `remoto` ligados agora nesta conversa: quem troca os servidores por fora
   *  (rea, Android, Chrome sob demanda) os repete, senão derrubaria o PC do cliente. */
  servidores(): Record<string, McpServerConfig>
  /** Roda uma troca de servidores feita por fora na mesma fila: duas trocas ao mesmo tempo
   *  montariam listas diferentes e a última desfaria a outra. */
  naFila<T>(troca: () => Promise<T>): Promise<T>
  desligar(): void
}

const ehInterno = (config: McpServerConfig): boolean => (config as { type?: string }).type === 'sdk'

export function ligarSuporteNaConversa(deps: LigacaoDeps): LigacaoSuporte {
  let suporte: McpServerConfig | null = deps.base[SUPORTE_SERVIDOR_INTERNO] ?? null
  // O que o processo do CLI tem agora: nasceu com a base, sem o `remoto`.
  let aplicado = `${suporte ? 1 : 0}|`
  let ligados: Record<string, McpServerConfig> = suporte ? { [SUPORTE_SERVIDOR_INTERNO]: suporte } : {}
  let fila: Promise<void> = Promise.resolve()
  let ativa = true

  const aplicarAgora = async (): Promise<void> => {
    if (!ativa) return
    const ativado = deps.ativado()
    const remoto = ativado ? deps.servico.mcpDaConversa(deps.convId) : null
    const sessao = remoto ? deps.servico.sessaoDaConversa(deps.convId) : null
    const alvo = `${ativado ? 1 : 0}|${sessao ?? ''}`
    if (alvo === aplicado) return
    const consulta = deps.consulta()
    if (!consulta) return
    const servidores: Record<string, McpServerConfig> = {}
    for (const [nome, config] of Object.entries(deps.base)) {
      if (nome !== SUPORTE_SERVIDOR_INTERNO && nome !== SUPORTE_SERVIDOR_REMOTO && ehInterno(config)) servidores[nome] = config
    }
    Object.assign(servidores, deps.extras?.())
    const nossos: Record<string, McpServerConfig> = {}
    if (ativado) nossos[SUPORTE_SERVIDOR_INTERNO] = suporte ??= deps.servidorSuporte()
    if (remoto) nossos[SUPORTE_SERVIDOR_REMOTO] = remoto
    try {
      const resultado = await consulta.setMcpServers({ ...servidores, ...nossos })
      aplicado = alvo
      if (remoto && resultado.errors?.[SUPORTE_SERVIDOR_REMOTO]) {
        delete nossos[SUPORTE_SERVIDOR_REMOTO]
        deps.aoFalhar?.('Não foi possível ligar as ferramentas do computador do cliente nesta conversa. Encerre a sessão de suporte e conecte de novo.')
      }
      ligados = nossos
    } catch {
      // A consulta morreu no meio: a próxima sessão do agente reaplica ao subir.
    }
  }

  const naFila = <T>(troca: () => Promise<T>): Promise<T> => {
    const feita = fila.then(troca, troca)
    fila = feita.then(() => undefined, () => undefined)
    return feita
  }
  const aplicar = (): Promise<void> => naFila(aplicarAgora)
  const sair = deps.servico.registrarConversa(deps.convId, aplicar)
  return {
    aplicar,
    servidores: () => ({ ...ligados }),
    naFila,
    desligar: () => {
      ativa = false
      sair()
    }
  }
}
